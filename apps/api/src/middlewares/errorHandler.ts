import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { ApiErrorBody } from '@codflow/shared';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';
import { fail, setReauthorizeHeaders, setRetrySessionHeader } from '../lib/http';
import {
  AppError,
  ErrorCode,
  NotFoundError,
  ReauthRequiredError,
  ScopesChangedError,
  ShopNotInstalledError,
  isAppError,
  toError,
} from '../lib/errors';
import { isRecordNotFoundError, isUniqueConstraintError } from '../db/prisma';
import { reauthorizeUrl } from '../shopify/urls';

const log = createLogger('error-handler');

/**
 * The single place errors become HTTP responses.
 *
 * Nothing else in the app calls `res.status(500)`. Services throw domain errors
 * and this translates them, which is what keeps the response envelope
 * consistent and stops an unhandled exception from leaking a stack trace, a
 * Prisma query, or a Shopify token into a merchant's browser.
 */

/** Terminal 404 for unmatched routes. Runs after every router. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`No route matches ${req.method} ${req.path}`));
};

/**
 * Normalizes anything thrown anywhere into an AppError.
 *
 * The Prisma and Zod branches exist because those libraries throw across layer
 * boundaries: a unique-constraint violation is genuinely a 409 to the client,
 * and reporting it as a 500 would have merchants retrying a request that can
 * never succeed.
 */
function normalize(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof z.ZodError) {
    return new AppError('Validation failed', 422, ErrorCode.VALIDATION_FAILED, {
      details: z.treeifyError(error),
      cause: error,
    });
  }

  if (isUniqueConstraintError(error)) {
    return new AppError('That record already exists', 409, ErrorCode.CONFLICT, { cause: error });
  }

  if (isRecordNotFoundError(error)) {
    return new AppError('Record not found', 404, ErrorCode.NOT_FOUND, { cause: error });
  }

  // Express's body parser reports an oversized or malformed payload this way.
  const candidate = error as { type?: string; status?: number; statusCode?: number };
  if (candidate?.type === 'entity.too.large') {
    return new AppError('Request body is too large', 413, ErrorCode.PAYLOAD_TOO_LARGE, {
      cause: error,
    });
  }
  if (candidate?.type === 'entity.parse.failed') {
    return new AppError('Request body is not valid JSON', 400, ErrorCode.BAD_REQUEST, {
      cause: error,
    });
  }

  return new AppError('Internal server error', 500, ErrorCode.INTERNAL, { cause: error }, false);
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Headers already flushed — the response is committed and the only useful
  // action left is to let Express tear the connection down.
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = normalize(error);

  if (appError.isOperational) {
    log.warn(
      {
        err: toError(error),
        code: appError.code,
        status: appError.statusCode,
        requestId: req.requestId,
        shop: req.auth?.shopDomain ?? null,
        path: req.path,
      },
      appError.message,
    );
  } else {
    // Non-operational means a bug or a dead dependency. Full stack, error level.
    log.error(
      {
        err: toError(error),
        requestId: req.requestId,
        shop: req.auth?.shopDomain ?? null,
        method: req.method,
        path: req.path,
      },
      'Unhandled error',
    );
  }

  // Recovery hints. These headers are how the embedded client knows the
  // difference between "give up" and "send the merchant through consent".
  if (appError instanceof ScopesChangedError || appError instanceof ReauthRequiredError) {
    const shop = (appError.details as { shop?: string } | undefined)?.shop;
    if (shop) setReauthorizeHeaders(res, reauthorizeUrl(shop));
  }

  if (appError.code === ErrorCode.SESSION_EXPIRED || appError instanceof ShopNotInstalledError) {
    setRetrySessionHeader(res);
  }

  const body: ApiErrorBody = {
    code: appError.code,
    // A non-operational error's message can name a table, a column, or an
    // internal host. Only operational messages are safe to return verbatim.
    message: appError.isOperational ? appError.message : 'Internal server error',
    requestId: req.requestId,
    ...(appError.details !== undefined && appError.isOperational
      ? { details: appError.details }
      : {}),
    ...(appError.retryAfter !== undefined ? { retryAfter: appError.retryAfter } : {}),
    // Stacks are invaluable while developing and a disclosure risk in
    // production, so they are attached only outside it.
    ...(!config.isProduction && !appError.isOperational
      ? { details: { stack: toError(error).stack } }
      : {}),
  };

  fail(res, appError.statusCode, body);
};

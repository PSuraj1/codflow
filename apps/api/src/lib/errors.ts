/**
 * Application error hierarchy.
 *
 * Services throw these; the error middleware is the single place that turns
 * them into HTTP responses. The distinction that matters is `isOperational`:
 * an expected failure (bad input, missing shop, rate limit) versus a bug or an
 * unavailable dependency. Operational errors return their own message to the
 * client; everything else returns a generic message and is logged at `error`.
 */

import { ApiErrorCode } from '@codflow/shared';

/**
 * Stable, machine-readable codes. The admin UI branches on these, not on prose.
 *
 * Defined in @codflow/shared so the client that reacts to a code and the server
 * that throws it cannot drift apart. Re-exported under the historical name so
 * call sites read `ErrorCode.NOT_FOUND` rather than `ApiErrorCode.NOT_FOUND`.
 */
export const ErrorCode = ApiErrorCode;
export type ErrorCodeType = ApiErrorCode;

export interface AppErrorOptions {
  /** Structured detail safe to return to the client (e.g. field-level errors). */
  details?: unknown;
  /** Underlying error, preserved for logs. Never serialized to the client. */
  cause?: unknown;
  /** Seconds the client should wait before retrying. Emitted as Retry-After. */
  retryAfter?: number;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeType;
  readonly isOperational: boolean;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCodeType,
    options: AppErrorOptions = {},
    isOperational = true,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = options.details;
    this.retryAfter = options.retryAfter;

    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options?: AppErrorOptions) {
    super(message, 400, ErrorCode.BAD_REQUEST, options);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', options?: AppErrorOptions) {
    super(message, 422, ErrorCode.VALIDATION_FAILED, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', options?: AppErrorOptions) {
    super(message, 401, ErrorCode.UNAUTHORIZED, options);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options?: AppErrorOptions) {
    super(message, 403, ErrorCode.FORBIDDEN, options);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', options?: AppErrorOptions) {
    super(message, 404, ErrorCode.NOT_FOUND, options);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', options?: AppErrorOptions) {
    super(message, 409, ErrorCode.CONFLICT, options);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', options?: AppErrorOptions) {
    super(message, 429, ErrorCode.RATE_LIMITED, options);
  }
}

/**
 * The shop has no usable offline session. The embedded client should restart
 * App Bridge so a fresh session token can be exchanged.
 */
export class ShopNotInstalledError extends AppError {
  constructor(shop: string) {
    super(`Shop ${shop} is not installed`, 401, ErrorCode.SHOP_NOT_INSTALLED, {
      details: { shop },
    });
  }
}

/**
 * Granted scopes no longer cover what the app declares. Managed installation
 * resolves this by sending the merchant through consent again.
 */
export class ScopesChangedError extends AppError {
  constructor(shop: string, missing: string[]) {
    super(`Shop ${shop} is missing required scopes`, 403, ErrorCode.SCOPES_CHANGED, {
      details: { shop, missing },
    });
  }
}

/**
 * The stored offline token no longer works — the merchant uninstalled and
 * reinstalled, revoked the app, or Shopify rotated the grant. Distinct from
 * ShopNotInstalledError because the shop row still exists and its data must be
 * preserved; only the credential is gone.
 */
export class ReauthRequiredError extends AppError {
  constructor(shop: string, reason: string) {
    super(`Shop ${shop} must re-authorize: ${reason}`, 403, ErrorCode.REAUTH_REQUIRED, {
      details: { shop, reason },
    });
  }
}

/**
 * The App Bridge session token was rejected. Almost always benign — these
 * tokens live about a minute, so one can expire between leaving the browser and
 * reaching the server. The client is expected to fetch a fresh token and retry
 * exactly once.
 */
export class SessionTokenError extends AppError {
  constructor(message = 'Invalid or expired session token') {
    super(message, 401, ErrorCode.SESSION_EXPIRED);
  }
}

export class WebhookVerificationError extends AppError {
  constructor(reason: string) {
    super(`Webhook verification failed: ${reason}`, 401, ErrorCode.WEBHOOK_INVALID, {
      details: { reason },
    });
  }
}

export class ShopifyApiError extends AppError {
  constructor(message: string, options?: AppErrorOptions) {
    super(message, 502, ErrorCode.SHOPIFY_API_ERROR, options);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', options?: AppErrorOptions) {
    super(message, 503, ErrorCode.SERVICE_UNAVAILABLE, options);
  }
}

/**
 * A programming fault or an unrecoverable state. Marked non-operational so the
 * error middleware hides the message and logs the full stack.
 */
export class InternalError extends AppError {
  constructor(message = 'Internal server error', options?: AppErrorOptions) {
    super(message, 500, ErrorCode.INTERNAL, options, false);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Narrows an unknown thrown value to an Error without losing the original. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

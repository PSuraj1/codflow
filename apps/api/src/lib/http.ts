import type { Request, Response } from 'express';
import type { ApiErrorBody, ApiSuccessResponse, Paginated } from '@codflow/shared';
import { ApiHeader } from '@codflow/shared';

/**
 * Response helpers.
 *
 * Every endpoint answers with the same envelope — `{ data }` on success,
 * `{ error }` on failure — so the admin client can discriminate on a single
 * property instead of inspecting status codes at each call site. Going through
 * these helpers rather than `res.json` directly is what keeps that true.
 */

export function ok<T>(res: Response, data: T): Response {
  const body: ApiSuccessResponse<T> = { data };
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T): Response {
  const body: ApiSuccessResponse<T> = { data };
  return res.status(201).json(body);
}

/** 202 — the work was accepted and handed to a queue, not completed. */
export function accepted<T>(res: Response, data: T): Response {
  const body: ApiSuccessResponse<T> = { data };
  return res.status(202).json(body);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

export function paginated<T>(res: Response, page: Paginated<T>): Response {
  const body: ApiSuccessResponse<Paginated<T>> = { data: page };
  return res.status(200).json(body);
}

export function fail(res: Response, statusCode: number, error: ApiErrorBody): Response {
  if (error.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(error.retryAfter));
  }
  return res.status(statusCode).json({ error });
}

/**
 * Marks a 403 as recoverable by sending the merchant through consent again.
 *
 * The two headers are a Shopify convention that App Bridge-aware clients
 * already understand. The URL must be opened in the *top* frame: Shopify's
 * `frame-ancestors` policy refuses to render the OAuth screen inside an app
 * iframe, so an in-frame redirect produces a blank panel with no error.
 */
export function setReauthorizeHeaders(res: Response, url: string): void {
  res.setHeader(ApiHeader.REAUTHORIZE, '1');
  res.setHeader(ApiHeader.REAUTHORIZE_URL, url);
}

/**
 * Tells the client its session token was stale and a retry with a fresh one is
 * worth attempting. Without this the admin would surface a hard auth error for
 * what is usually just clock drift on a ~60 second token.
 */
export function setRetrySessionHeader(res: Response): void {
  res.setHeader(ApiHeader.RETRY_INVALID_SESSION, '1');
}

/**
 * Client IP, honouring the proxy chain.
 *
 * `app.set('trust proxy', ...)` makes Express populate `req.ip` from
 * `X-Forwarded-For`, which is what Railway/Render/Fly put the real client in.
 * The fallback exists because `req.ip` is undefined when the socket is already
 * closed — which happens on aborted storefront requests, exactly the ones the
 * fraud engine most wants to record.
 */
export function clientIp(req: Request): string | null {
  return req.ip ?? req.socket.remoteAddress ?? null;
}

/** First value of a header that may legitimately arrive repeated. */
export function headerValue(req: Request, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

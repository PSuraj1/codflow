import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { ApiHeader } from '@codflow/shared';

/**
 * Request correlation.
 *
 * Every response carries a request id, and every log line emitted while
 * handling that request carries the same one. When a merchant reports "placing
 * an order failed", the id from their error banner is enough to pull the exact
 * server-side trace — including the BullMQ jobs enqueued downstream, which read
 * the id out of the async context rather than having it threaded through every
 * function signature.
 */

interface RequestContext {
  readonly requestId: string;
  shopDomain?: string;
  shopId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Current request's context, or undefined outside a request (worker, boot). */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Records the tenant on the active context once authentication resolves it, so
 * later log lines and audit rows are attributed without extra plumbing.
 */
export function bindShopToContext(shopDomain: string, shopId: string): void {
  const context = storage.getStore();
  if (!context) return;
  context.shopDomain = shopDomain;
  context.shopId = shopId;
}

/**
 * Accepts an inbound correlation id when a trusted proxy supplies one, so a
 * trace started at the edge stays intact. Untrusted-looking values are
 * discarded rather than logged — the header is client-controlled, and a
 * multi-kilobyte id would end up in every log line for the request.
 */
function inboundRequestId(req: Request): string | null {
  const header = req.headers[ApiHeader.REQUEST_ID] ?? req.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;

  if (!value) return null;
  if (value.length > 64) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;

  return value;
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = inboundRequestId(req) ?? randomUUID();

  req.requestId = id;
  res.setHeader(ApiHeader.REQUEST_ID, id);

  storage.run({ requestId: id }, () => {
    next();
  });
}

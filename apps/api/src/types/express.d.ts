import type { JwtPayload, Session } from '@shopify/shopify-api';

/**
 * Express request augmentation.
 *
 * Everything middleware attaches to a request is declared here so downstream
 * handlers get real types instead of `(req as any).shop`. Each property is
 * optional except `requestId`, which is set by the very first middleware and is
 * therefore always present by the time any route runs.
 */

/** Populated by `authenticateAdmin` for every `/api/admin/*` request. */
export interface AdminAuthContext {
  /** Canonical `*.myshopify.com` domain. Already sanitized. */
  readonly shopDomain: string;
  /** `Shop.id` — the tenant key every repository filters on. */
  readonly shopId: string;
  /** Offline session carrying the Admin API access token. */
  readonly session: Session;
  /** Verified claims of the App Bridge session token that authorized this request. */
  readonly token: JwtPayload;
  /**
   * Numeric staff user id from the token's `sub` claim. Recorded on audit rows
   * so a settings change can be attributed to a person, not just to a shop.
   */
  readonly userId: string | null;
}

/** Populated by `verifyWebhook` after the HMAC check passes. */
export interface WebhookContext {
  readonly topic: string;
  readonly shopDomain: string;
  readonly webhookId: string;
  readonly apiVersion: string;
  readonly triggeredAt: Date | null;
  readonly subTopic: string | null;
  /** Parsed body. Only produced after verification, never before. */
  readonly payload: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id echoed in the response headers and every log line. */
      requestId: string;
      /**
       * Exact bytes of the request body. Only captured on webhook routes, where
       * HMAC verification must run against what Shopify actually sent — a
       * JSON round trip through `express.json` reorders keys and normalizes
       * unicode escapes, which invalidates the signature.
       */
      rawBody?: Buffer;
      auth?: AdminAuthContext;
      webhook?: WebhookContext;
    }
  }
}

export {};

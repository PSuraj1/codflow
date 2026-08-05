/**
 * Contract every webhook handler implements.
 *
 * Handlers receive an already-verified delivery: the HMAC passed, the topic and
 * shop domain are sanitized, and the payload is parsed. They are pure business
 * logic over that input, which is what makes them testable without an HTTP
 * server — the fraud rescan and sheet sync handlers in later phases depend on
 * that property.
 */
export interface WebhookHandlerContext {
  readonly topic: string;
  readonly shopDomain: string;
  /**
   * Tenant id, or null when the shop has no row. Legitimately null for
   * compliance topics, which Shopify may deliver for a shop that abandoned
   * installation partway through.
   */
  readonly shopId: string | null;
  readonly webhookId: string;
  readonly payload: Record<string, unknown>;
  readonly triggeredAt: Date | null;
}

export type WebhookHandler = (context: WebhookHandlerContext) => Promise<void>;

/** Reads a string field from an untyped webhook payload. */
export function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads a numeric id, which Shopify sends as a number in REST-shaped payloads. */
export function readId(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

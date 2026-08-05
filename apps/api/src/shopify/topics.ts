/**
 * Webhook topics this app subscribes to.
 *
 * These mirror `[[webhooks.subscriptions]]` in shopify.app.toml exactly. The
 * TOML is the source of truth — Shopify reads it on `shopify app deploy` and
 * creates app-specific subscriptions from it — but the API needs the same
 * strings to route incoming deliveries, and a typo there produces a silently
 * ignored webhook rather than an error.
 *
 * Shopify sends the topic header in `UPPER/SNAKE` form (`ORDERS_CREATE`); the
 * library's `topicForStorage` normalizes it to the slash form used below.
 */

export const WebhookTopic = {
  // ---- Mandatory compliance topics. Shopify rejects app submission without
  // all three, and requires a 200 within 5 seconds even when there is no data.
  CUSTOMERS_DATA_REQUEST: 'customers/data_request',
  CUSTOMERS_REDACT: 'customers/redact',
  SHOP_REDACT: 'shop/redact',

  // ---- App lifecycle
  APP_UNINSTALLED: 'app/uninstalled',
  APP_SCOPES_UPDATE: 'app/scopes_update',
  APP_SUBSCRIPTIONS_UPDATE: 'app_subscriptions/update',

  // ---- Order lifecycle
  ORDERS_CREATE: 'orders/create',
  ORDERS_UPDATED: 'orders/updated',
  ORDERS_CANCELLED: 'orders/cancelled',
  ORDERS_FULFILLED: 'orders/fulfilled',
  REFUNDS_CREATE: 'refunds/create',
} as const;

export type WebhookTopic = (typeof WebhookTopic)[keyof typeof WebhookTopic];

const ALL_TOPICS = new Set<string>(Object.values(WebhookTopic));

export function isKnownTopic(topic: string): topic is WebhookTopic {
  return ALL_TOPICS.has(topic);
}

/**
 * Topics that must be handled inline rather than queued.
 *
 * The general rule is verify-and-enqueue, because Shopify's 5 second budget is
 * not enough for real work. These two are the exception: `app/uninstalled`
 * invalidates the offline session that a queued job would need in order to run,
 * and `app/scopes_update` must be reflected before the merchant's next request
 * or the app will keep insisting they re-consent to scopes they just granted.
 * Both are cheap — a session delete and a column update.
 */
export const INLINE_TOPICS: readonly WebhookTopic[] = [
  WebhookTopic.APP_UNINSTALLED,
  WebhookTopic.APP_SCOPES_UPDATE,
];

/**
 * Compliance topics. Shopify may deliver these for a shop that never completed
 * installation, so their handlers must tolerate a missing `Shop` row.
 */
export const COMPLIANCE_TOPICS: readonly WebhookTopic[] = [
  WebhookTopic.CUSTOMERS_DATA_REQUEST,
  WebhookTopic.CUSTOMERS_REDACT,
  WebhookTopic.SHOP_REDACT,
];

import type { Prisma } from '@prisma/client';
import type { WebhookContext } from '../../types/express';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import { WebhookTopic } from '../../shopify/topics';
import * as shopRepository from '../shop/repository';
import * as repository from './repository';
import type { WebhookHandler, WebhookHandlerContext } from './handlers/types';
import { appUninstalled } from './handlers/appUninstalled';
import { appScopesUpdate } from './handlers/appScopesUpdate';
import { customersDataRequest } from './handlers/customersDataRequest';
import { customersRedact } from './handlers/customersRedact';
import { shopRedact } from './handlers/shopRedact';
import { appSubscriptionsUpdate } from './handlers/appSubscriptionsUpdate';
import {
  ordersCancelled,
  ordersCreate,
  ordersFulfilled,
  ordersUpdated,
  refundsCreate,
} from './handlers/ordersLifecycle';

const log = createLogger('webhook-service');

/**
 * Webhook dispatch.
 *
 * Shopify expects a response within 5 seconds and treats anything slower as a
 * failed delivery, retrying with backoff for up to 48 hours. Two consequences
 * shape this module:
 *
 *  1. **The receipt is written before any work happens.** The delivery is
 *     durable from that moment, so a handler that dies mid-way leaves a record
 *     to replay rather than a lost event.
 *  2. **A handler failure still returns 200.** This is the counter-intuitive
 *     part. Shopify's retry cannot fix a bug in the handler — it will fail
 *     identically — and repeated 500s eventually get the subscription
 *     *disabled*, which is far worse than one unprocessed event. The failure is
 *     recorded on the receipt and replayed from there.
 *
 * The exception is HMAC verification, which happens upstream in middleware and
 * legitimately answers 401.
 */

/**
 * Topics with a processor in this build.
 *
 * The order-lifecycle topics arrived with analytics (Phase 8). Deliveries from
 * before then were still received, verified and stored with their full payload,
 * so `replay(topic)` drains that backlog into the aggregates rather than
 * starting the merchant's history from the day the feature shipped — which is
 * exactly what `repository.findPending` was built for.
 */
const handlers: Partial<Record<string, WebhookHandler>> = {
  [WebhookTopic.APP_UNINSTALLED]: appUninstalled,
  [WebhookTopic.APP_SCOPES_UPDATE]: appScopesUpdate,
  [WebhookTopic.APP_SUBSCRIPTIONS_UPDATE]: appSubscriptionsUpdate,
  [WebhookTopic.CUSTOMERS_DATA_REQUEST]: customersDataRequest,
  [WebhookTopic.CUSTOMERS_REDACT]: customersRedact,
  [WebhookTopic.SHOP_REDACT]: shopRedact,

  [WebhookTopic.ORDERS_CREATE]: ordersCreate,
  [WebhookTopic.ORDERS_UPDATED]: ordersUpdated,
  [WebhookTopic.ORDERS_CANCELLED]: ordersCancelled,
  [WebhookTopic.ORDERS_FULFILLED]: ordersFulfilled,
  [WebhookTopic.REFUNDS_CREATE]: refundsCreate,
};

export interface DispatchResult {
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly handled: boolean;
  readonly failed: boolean;
}

export async function dispatch(webhook: WebhookContext): Promise<DispatchResult> {
  const shop = await shopRepository.findIdByDomain(webhook.shopDomain);
  const shopId = shop?.id ?? null;

  const receipt = await repository.recordReceipt({
    shopifyWebhookId: webhook.webhookId,
    topic: webhook.topic,
    shopDomain: webhook.shopDomain,
    apiVersion: webhook.apiVersion,
    triggeredAt: webhook.triggeredAt,
    payload: webhook.payload as Prisma.InputJsonValue,
    shopId,
  });

  if (receipt.duplicate) {
    // Shopify guarantees at-least-once delivery, so this is expected traffic,
    // not an anomaly. Processing it again would double-count an order or
    // re-fire a Purchase event at Meta.
    log.debug(
      { topic: webhook.topic, shop: webhook.shopDomain, webhookId: webhook.webhookId },
      'Duplicate delivery ignored',
    );
    return { eventId: receipt.id, duplicate: true, handled: false, failed: false };
  }

  const handler = handlers[webhook.topic];

  if (!handler) {
    await repository.markUnhandled(receipt.id);
    log.info(
      { topic: webhook.topic, shop: webhook.shopDomain },
      'No processor registered for topic — delivery stored for replay',
    );
    return { eventId: receipt.id, duplicate: false, handled: false, failed: false };
  }

  const context: WebhookHandlerContext = {
    topic: webhook.topic,
    shopDomain: webhook.shopDomain,
    shopId,
    webhookId: webhook.webhookId,
    payload: webhook.payload,
    triggeredAt: webhook.triggeredAt,
  };

  const startedAt = Date.now();

  try {
    await repository.markInProgress(receipt.id);
    await handler(context);
    await repository.markProcessed(receipt.id);

    log.info(
      { topic: webhook.topic, shop: webhook.shopDomain, durationMs: Date.now() - startedAt },
      'Webhook processed',
    );

    return { eventId: receipt.id, duplicate: false, handled: true, failed: false };
  } catch (error) {
    const failure = toError(error);

    // Logged at error because this needs a human, even though the HTTP response
    // will still be 200 — see the note at the top of this file.
    log.error(
      { err: failure, topic: webhook.topic, shop: webhook.shopDomain, eventId: receipt.id },
      'Webhook handler failed — recorded for replay',
    );

    await repository.markFailed(receipt.id, failure.message).catch((markError: unknown) => {
      log.error({ err: toError(markError) }, 'Could not record webhook failure');
    });

    return { eventId: receipt.id, duplicate: false, handled: false, failed: true };
  }
}

/**
 * Re-runs stored deliveries for a topic.
 *
 * The path back from an incident: fix the handler, deploy, replay. Also how a
 * later phase drains the backlog of topics it had no processor for.
 */
export async function replay(topic: string, limit = 100): Promise<{ processed: number; failed: number }> {
  const handler = handlers[topic];

  if (!handler) {
    throw new Error(`No processor registered for topic "${topic}"`);
  }

  const events = await repository.findPending(topic, limit);
  let processed = 0;
  let failed = 0;

  for (const event of events) {
    const shop = await shopRepository.findIdByDomain(event.shopDomain);

    try {
      await repository.markInProgress(event.id);
      await handler({
        topic: event.topic,
        shopDomain: event.shopDomain,
        shopId: shop?.id ?? null,
        webhookId: event.shopifyWebhookId,
        payload: event.payload as Record<string, unknown>,
        triggeredAt: event.triggeredAt,
      });
      await repository.markProcessed(event.id);
      processed += 1;
    } catch (error) {
      await repository.markFailed(event.id, toError(error).message);
      failed += 1;
    }
  }

  log.info({ topic, processed, failed }, 'Webhook replay complete');
  return { processed, failed };
}

/** Topics this build actually processes. Surfaced on the diagnostics screen. */
export function registeredTopics(): string[] {
  return Object.keys(handlers);
}

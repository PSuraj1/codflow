import { CodOrderStatus, Prisma, type CodOrder } from '@prisma/client';
import { createLogger } from '../../../lib/logger';
import * as orderRepository from '../../orders/repository';
import * as stats from '../../analytics/stats';
import type { WebhookHandler, WebhookHandlerContext } from './types';

const log = createLogger('webhook:orders');

/**
 * Order lifecycle webhooks — what happens to a COD order after Shopify has it.
 *
 * These are the events CodFlow cannot observe on its own. Once an order is
 * pushed, everything that follows happens in Shopify's admin: the merchant
 * cancels it, a courier delivers it, a refund is issued. Without these handlers
 * the dashboard could only ever report orders *taken*, which for cash on
 * delivery is the least interesting half — a COD business lives or dies on how
 * many of those orders are actually delivered and paid for.
 *
 * Three properties this file is built around:
 *
 *  1. **Most deliveries are not ours.** Every order the merchant takes through
 *     their normal checkout produces the same webhooks. An unmatched order is
 *     the common case and exits silently.
 *  2. **Every transition is idempotent.** Shopify delivers at least once, and
 *     `service.replay()` can re-run a stored delivery deliberately. So each
 *     handler checks whether the transition has already been applied before
 *     recording it — a second `orders/cancelled` for the same order must not
 *     count a second cancellation.
 *  3. **The order row is the source of truth, not the counter.** The status and
 *     timestamp are written first; the analytics increment follows. If the
 *     increment is lost, a rebuild recovers it from those columns. If the
 *     status write were lost, nothing could.
 */

/** Shopify sends REST-shaped payloads on these topics: a numeric `id`. */
function orderGid(payload: Record<string, unknown>): string | null {
  const id = payload.id;

  if (typeof id === 'number' && Number.isFinite(id)) return `gid://shopify/Order/${id}`;
  if (typeof id === 'string' && id.startsWith('gid://')) return id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return `gid://shopify/Order/${id}`;

  return null;
}

/** `order_id` on a refund payload, which describes the refund rather than the order. */
function refundedOrderGid(payload: Record<string, unknown>): string | null {
  const id = payload.order_id;

  if (typeof id === 'number' && Number.isFinite(id)) return `gid://shopify/Order/${id}`;
  if (typeof id === 'string' && /^\d+$/.test(id)) return `gid://shopify/Order/${id}`;

  return null;
}

function timestamp(payload: Record<string, unknown>, key: string, fallback: Date | null): Date {
  const value = payload[key];

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  // The webhook's own trigger time is closer to the truth than "now", which
  // could be days later on a replayed backlog and would file the event under
  // the wrong day.
  return fallback ?? new Date();
}

/**
 * Finds the COD order a delivery refers to.
 *
 * Returns null — quietly — for anything CodFlow did not create.
 */
async function locate(
  context: WebhookHandlerContext,
  gid: string | null,
): Promise<CodOrder | null> {
  if (!context.shopId || !gid) return null;

  return orderRepository.findByShopifyGid(context.shopId, gid);
}

/**
 * `orders/create` — an order appeared in Shopify.
 *
 * Deliberately close to a no-op. A COD order was already counted when the
 * shopper submitted the form, and counting it again here would double every
 * order on the dashboard. What this does do is confirm the linkage and note it
 * on the timeline, which is what a merchant looks at when an order's history
 * has a gap in it.
 */
export const ordersCreate: WebhookHandler = async (context) => {
  const order = await locate(context, orderGid(context.payload));
  if (!order) return;

  const name = typeof context.payload.name === 'string' ? context.payload.name : null;

  if (name && order.shopifyOrderNumber !== name) {
    await orderRepository.updateStatus(order.id, order.status, { shopifyOrderNumber: name });
  }

  log.debug(
    { reference: order.reference, orderNumber: name },
    'Shopify confirmed a CodFlow order — already counted at submission',
  );
};

/**
 * `orders/cancelled` — the merchant cancelled the order.
 *
 * For cash on delivery this is the number that matters most after revenue: a
 * cancelled COD order is one the merchant may already have paid to ship.
 * Recorded on the cancellation date rather than the order date, so a Monday
 * order cancelled on Thursday shows as Monday revenue and a Thursday
 * cancellation — which is what the merchant's own books will say.
 */
export const ordersCancelled: WebhookHandler = async (context) => {
  const order = await locate(context, orderGid(context.payload));
  if (!order) return;

  if (order.cancelledAt) {
    log.debug({ reference: order.reference }, 'Cancellation already recorded — ignoring replay');
    return;
  }

  const cancelledAt = timestamp(context.payload, 'cancelled_at', context.triggeredAt);
  const reason = typeof context.payload.cancel_reason === 'string' ? context.payload.cancel_reason : null;

  await orderRepository.updateStatus(order.id, CodOrderStatus.CANCELLED, {
    cancelledAt,
    cancelReason: reason,
  });

  await orderRepository.appendEvent(
    order.id,
    'order.cancelled',
    reason ? `Cancelled in Shopify (${reason}).` : 'Cancelled in Shopify.',
    'shopify',
    { cancelledAt: cancelledAt.toISOString() },
  );

  await stats.recordOrderCancelled(order.shopId, order.total, cancelledAt);

  log.info({ reference: order.reference, reason }, 'COD order cancelled');
};

/**
 * `orders/fulfilled` — the order was delivered.
 *
 * The one event that turns a COD order into money. Everything before it is a
 * promise.
 */
export const ordersFulfilled: WebhookHandler = async (context) => {
  const order = await locate(context, orderGid(context.payload));
  if (!order) return;

  if (order.fulfilledAt) return;

  const fulfilledAt = timestamp(context.payload, 'updated_at', context.triggeredAt);

  await orderRepository.updateStatus(order.id, CodOrderStatus.FULFILLED, { fulfilledAt });

  await orderRepository.appendEvent(
    order.id,
    'order.fulfilled',
    'Delivered.',
    'shopify',
    { fulfilledAt: fulfilledAt.toISOString() },
  );

  await stats.recordOrderFulfilled(order.shopId, fulfilledAt);

  log.info({ reference: order.reference }, 'COD order fulfilled');
};

/**
 * `refunds/create` — money went back.
 *
 * Treated as a return rather than a cancellation. The distinction is real for
 * COD: a cancellation happened before the parcel moved, a return happened after
 * it was delivered and came back, and the second costs the merchant shipping
 * both ways. Reporting them as one number hides which problem they have.
 *
 * The refunded amount is read from the payload rather than assumed to be the
 * order total, because partial refunds are ordinary — a damaged item on a
 * multi-item order.
 */
export const refundsCreate: WebhookHandler = async (context) => {
  const order = await locate(context, refundedOrderGid(context.payload));
  if (!order) return;

  if (order.returnedAt) return;

  const refundedAt = timestamp(context.payload, 'created_at', context.triggeredAt);
  const amount = refundAmount(context.payload) ?? order.total;

  await orderRepository.updateStatus(order.id, CodOrderStatus.RETURNED, {
    returnedAt: refundedAt,
    refundedAt,
  });

  await orderRepository.appendEvent(
    order.id,
    'order.refunded',
    `Refunded ${amount.toFixed(2)} ${order.currency}.`,
    'shopify',
    { refundedAt: refundedAt.toISOString(), amount: amount.toFixed(2) },
  );

  await stats.recordOrderReturned(order.shopId, amount, refundedAt);

  log.info({ reference: order.reference, amount: amount.toFixed(2) }, 'COD order refunded');
};

/**
 * Sums a refund payload's transactions.
 *
 * `transactions[].amount` is what actually moved. The refund's line items carry
 * quantities rather than money, and `total_refund_set` is not present on every
 * API version's payload — so the transactions are the dependable source.
 */
function refundAmount(payload: Record<string, unknown>): Prisma.Decimal | null {
  const transactions = payload.transactions;
  if (!Array.isArray(transactions)) return null;

  let total = new Prisma.Decimal(0);
  let found = false;

  for (const entry of transactions) {
    if (!entry || typeof entry !== 'object') continue;

    const record = entry as Record<string, unknown>;
    // Only successful refund transactions. A failed or pending one is not money
    // the merchant has lost yet.
    if (record.kind !== 'refund' || record.status !== 'success') continue;

    const amount = record.amount;
    const parsed = typeof amount === 'string' || typeof amount === 'number' ? Number(amount) : NaN;

    if (Number.isFinite(parsed)) {
      total = total.add(parsed);
      found = true;
    }
  }

  return found ? total : null;
}

/**
 * `orders/updated` — the catch-all.
 *
 * Shopify fires this for everything, most of which CodFlow has no opinion
 * about. It exists here to reconcile the two transitions that can arrive
 * *only* this way: an order cancelled through an API that does not emit
 * `orders/cancelled`, and a fulfilment status that changed without a
 * `orders/fulfilled` delivery. Both re-use the handlers above, which are
 * idempotent, so a redundant delivery costs one query and changes nothing.
 */
export const ordersUpdated: WebhookHandler = async (context) => {
  const order = await locate(context, orderGid(context.payload));
  if (!order) return;

  if (context.payload.cancelled_at && !order.cancelledAt) {
    await ordersCancelled(context);
    return;
  }

  if (context.payload.fulfillment_status === 'fulfilled' && !order.fulfilledAt) {
    await ordersFulfilled(context);
  }
};

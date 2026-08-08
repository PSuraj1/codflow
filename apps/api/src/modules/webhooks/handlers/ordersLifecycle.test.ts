import type { CodOrder } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order lifecycle webhooks.
 *
 * These handlers write the half of the dashboard CODkar cannot observe on its
 * own — what happened to an order after Shopify had it. Three properties are
 * load-bearing:
 *
 *  1. **Most deliveries are not ours.** Every order from the merchant's normal
 *     checkout fires the same webhooks, and acting on one would attribute a
 *     stranger's order to COD.
 *  2. **Every transition is idempotent.** Shopify delivers at least once, and
 *     the replay path re-runs stored deliveries deliberately. A second
 *     `orders/cancelled` must not count a second cancellation.
 *  3. **Events land on the day they happened.** A replayed backlog processed
 *     next week must still file a cancellation under the day Shopify sent it,
 *     not under the day the replay ran.
 */

const {
  findByShopifyGid,
  updateStatus,
  appendEvent,
  recordOrderCancelled,
  recordOrderReturned,
  recordOrderFulfilled,
} = vi.hoisted(() => ({
  findByShopifyGid: vi.fn(),
  updateStatus: vi.fn(),
  appendEvent: vi.fn(),
  recordOrderCancelled: vi.fn(),
  recordOrderReturned: vi.fn(),
  recordOrderFulfilled: vi.fn(),
}));

vi.mock('../../orders/repository', () => ({ findByShopifyGid, updateStatus, appendEvent }));
vi.mock('../../analytics/stats', () => ({
  recordOrderCancelled,
  recordOrderReturned,
  recordOrderFulfilled,
}));

const { ordersCancelled, ordersFulfilled, ordersUpdated, refundsCreate } = await import(
  './ordersLifecycle'
);
const { Prisma } = await import('@prisma/client');

function order(overrides: Partial<CodOrder> = {}): CodOrder {
  return {
    id: 'order-1',
    shopId: 'shop-1',
    reference: 'CF-ABC123',
    total: new Prisma.Decimal('1499.00'),
    currency: 'INR',
    cancelledAt: null,
    returnedAt: null,
    fulfilledAt: null,
    shopifyOrderNumber: '#1001',
    status: 'PUSHED_TO_SHOPIFY',
    ...overrides,
  } as CodOrder;
}

function context(payload: Record<string, unknown>, triggeredAt: Date | null = null) {
  return {
    topic: 'orders/cancelled',
    shopDomain: 'demo.myshopify.com',
    shopId: 'shop-1',
    webhookId: 'wh-1',
    payload,
    triggeredAt,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByShopifyGid.mockResolvedValue(null);
});

describe('locating the order', () => {
  it('ignores an order CODkar did not create', async () => {
    await ordersCancelled(context({ id: 99, cancelled_at: '2026-03-04T10:00:00Z' }));

    expect(updateStatus).not.toHaveBeenCalled();
    expect(recordOrderCancelled).not.toHaveBeenCalled();
  });

  it('converts Shopify’s numeric id into the gid the order stores', async () => {
    await ordersCancelled(context({ id: 1234567890 }));

    expect(findByShopifyGid).toHaveBeenCalledWith('shop-1', 'gid://shopify/Order/1234567890');
  });

  it('does nothing for a delivery with no shop row', async () => {
    await ordersCancelled({ ...context({ id: 1 }), shopId: null });

    expect(findByShopifyGid).not.toHaveBeenCalled();
  });
});

describe('orders/cancelled', () => {
  it('records the cancellation with the order’s value', async () => {
    findByShopifyGid.mockResolvedValue(order());

    await ordersCancelled(
      context({ id: 1, cancelled_at: '2026-03-04T10:00:00Z', cancel_reason: 'customer' }),
    );

    expect(updateStatus).toHaveBeenCalledWith(
      'order-1',
      'CANCELLED',
      expect.objectContaining({ cancelReason: 'customer' }),
    );

    const [shopId, value, at] = recordOrderCancelled.mock.calls[0] ?? [];
    expect(shopId).toBe('shop-1');
    expect(value.toString()).toBe('1499');
    expect(at.toISOString()).toBe('2026-03-04T10:00:00.000Z');
  });

  it('ignores a replayed delivery', async () => {
    findByShopifyGid.mockResolvedValue(order({ cancelledAt: new Date('2026-03-04T10:00:00Z') }));

    await ordersCancelled(context({ id: 1, cancelled_at: '2026-03-04T10:00:00Z' }));

    expect(updateStatus).not.toHaveBeenCalled();
    expect(recordOrderCancelled).not.toHaveBeenCalled();
  });

  it('files a replayed backlog under the day it happened, not the day of the replay', async () => {
    findByShopifyGid.mockResolvedValue(order());

    // No `cancelled_at` in the payload — the delivery's own trigger time is the
    // closest thing to the truth, and "now" could be weeks later.
    await ordersCancelled(context({ id: 1 }, new Date('2026-02-01T08:00:00Z')));

    const at = recordOrderCancelled.mock.calls[0]?.[2] as Date;
    expect(at.toISOString()).toBe('2026-02-01T08:00:00.000Z');
  });
});

describe('orders/fulfilled', () => {
  it('records the delivery — the only outcome that turns COD into money', async () => {
    findByShopifyGid.mockResolvedValue(order());

    await ordersFulfilled(context({ id: 1, updated_at: '2026-03-06T12:00:00Z' }));

    expect(updateStatus).toHaveBeenCalledWith('order-1', 'FULFILLED', expect.any(Object));
    expect(recordOrderFulfilled).toHaveBeenCalledTimes(1);
  });

  it('ignores a second delivery of the same fulfilment', async () => {
    findByShopifyGid.mockResolvedValue(order({ fulfilledAt: new Date('2026-03-06T12:00:00Z') }));

    await ordersFulfilled(context({ id: 1 }));

    expect(recordOrderFulfilled).not.toHaveBeenCalled();
  });
});

describe('refunds/create', () => {
  it('sums the successful refund transactions rather than assuming the order total', async () => {
    findByShopifyGid.mockResolvedValue(order());

    await refundsCreate(
      context({
        order_id: 1,
        created_at: '2026-03-08T09:00:00Z',
        transactions: [
          { kind: 'refund', status: 'success', amount: '400.00' },
          { kind: 'refund', status: 'success', amount: '99.50' },
          // A failed attempt is not money the merchant has lost.
          { kind: 'refund', status: 'failure', amount: '1000.00' },
          { kind: 'sale', status: 'success', amount: '1499.00' },
        ],
      }),
    );

    const value = recordOrderReturned.mock.calls[0]?.[1];
    expect(value.toString()).toBe('499.5');
  });

  it('falls back to the order total when the payload carries no transactions', async () => {
    findByShopifyGid.mockResolvedValue(order());

    await refundsCreate(context({ order_id: 1 }));

    expect(recordOrderReturned.mock.calls[0]?.[1].toString()).toBe('1499');
  });

  it('reads the refund’s order_id, not the refund’s own id', async () => {
    await refundsCreate(context({ id: 555, order_id: 1234 }));

    expect(findByShopifyGid).toHaveBeenCalledWith('shop-1', 'gid://shopify/Order/1234');
  });
});

describe('orders/updated', () => {
  it('reconciles a cancellation that arrived only on the catch-all topic', async () => {
    findByShopifyGid.mockResolvedValue(order());

    await ordersUpdated(context({ id: 1, cancelled_at: '2026-03-04T10:00:00Z' }));

    expect(recordOrderCancelled).toHaveBeenCalledTimes(1);
  });

  it('does nothing for the ordinary update that carries no transition', async () => {
    findByShopifyGid.mockResolvedValue(order());

    await ordersUpdated(context({ id: 1, note: 'Merchant edited a note' }));

    expect(updateStatus).not.toHaveBeenCalled();
    expect(recordOrderCancelled).not.toHaveBeenCalled();
    expect(recordOrderFulfilled).not.toHaveBeenCalled();
  });
});

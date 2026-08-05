import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The nightly retention sweep.
 *
 * Three properties carry the weight here, and all three are the difference
 * between a compliance control and an outage:
 *
 *  1. **It batches.** One unbounded `updateMany` across years of orders holds
 *     write locks that the shopper-facing submission path queues behind.
 *  2. **One shop's failure does not end the run.** The job is scheduled rather
 *     than retried per shop, so a shop skipped because an earlier one threw
 *     waits a full day for the next attempt.
 *  3. **A shop without a usable retention period is skipped, not defaulted.**
 *     Inventing a number here would put a second copy of it somewhere it can
 *     drift from the schema's.
 */

const { findShopsForRetentionSweep, anonymiseExpiredOrders, record } = vi.hoisted(() => ({
  findShopsForRetentionSweep: vi.fn(),
  anonymiseExpiredOrders: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../modules/shop/repository', () => ({
  findShopsForRetentionSweep,
  anonymiseExpiredOrders,
}));

vi.mock('../modules/audit/service', () => ({
  record,
  AuditAction: { RETENTION_ENFORCED: 'compliance.retention_enforced' },
  AuditActor: { CRON: 'cron' },
}));

const { processDataRetention } = await import('./enforceRetention');

function job(): Job<Record<string, never>> {
  return { data: {}, attemptsMade: 0, updateProgress: vi.fn() } as unknown as Job<
    Record<string, never>
  >;
}

function shop(overrides: Record<string, unknown> = {}) {
  return {
    id: 'shop-1',
    domain: 'demo.myshopify.com',
    settings: { orderRetentionDays: 365 },
    ...overrides,
  };
}

/** Makes the batching loop terminate after `batches` full batches. */
function batches(count: number, size = 500) {
  for (let index = 0; index < count; index += 1) {
    anonymiseExpiredOrders.mockResolvedValueOnce(size);
  }
  anonymiseExpiredOrders.mockResolvedValue(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  findShopsForRetentionSweep.mockResolvedValue([shop()]);
  anonymiseExpiredOrders.mockResolvedValue(0);
  record.mockResolvedValue(undefined);
});

describe('cutoff', () => {
  it('derives the cutoff from the shop’s own retention period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T03:00:00Z'));

    findShopsForRetentionSweep.mockResolvedValue([
      shop({ settings: { orderRetentionDays: 30 } }),
    ]);

    await processDataRetention(job());

    const [, cutoff] = anonymiseExpiredOrders.mock.calls[0] as [string, Date, number];
    expect(cutoff.toISOString()).toBe('2026-07-03T03:00:00.000Z');

    vi.useRealTimers();
  });

  /**
   * A shop mid-provisioning has no settings row yet, and therefore no orders
   * old enough to matter.
   */
  it.each([
    ['no settings row', { settings: null }],
    ['a zero period', { settings: { orderRetentionDays: 0 } }],
    ['a negative period', { settings: { orderRetentionDays: -1 } }],
  ])('skips a shop with %s', async (_label, overrides) => {
    findShopsForRetentionSweep.mockResolvedValue([shop(overrides)]);

    await processDataRetention(job());

    expect(anonymiseExpiredOrders).not.toHaveBeenCalled();
  });
});

describe('batching', () => {
  it('keeps going until a batch comes back empty', async () => {
    batches(3);

    await processDataRetention(job());

    // Three full batches, then the empty one that stops the loop.
    expect(anonymiseExpiredOrders).toHaveBeenCalledTimes(4);
  });

  it('stops at the per-shop ceiling rather than sweeping without bound', async () => {
    // Never returns empty: without a ceiling this loops forever.
    anonymiseExpiredOrders.mockResolvedValue(500);

    await processDataRetention(job());

    expect(anonymiseExpiredOrders).toHaveBeenCalledTimes(40);
  });

  it('does not query a shop twice when the first batch is empty', async () => {
    await processDataRetention(job());

    expect(anonymiseExpiredOrders).toHaveBeenCalledTimes(1);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('resilience', () => {
  it('continues to the next shop when one throws', async () => {
    findShopsForRetentionSweep.mockResolvedValue([
      shop({ id: 'shop-1', domain: 'broken.myshopify.com' }),
      shop({ id: 'shop-2', domain: 'fine.myshopify.com' }),
    ]);

    anonymiseExpiredOrders
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(12)
      .mockResolvedValue(0);

    await expect(processDataRetention(job())).resolves.toBeUndefined();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-2' }));
  });

  it('survives a shop with no orders at all', async () => {
    findShopsForRetentionSweep.mockResolvedValue([]);

    await expect(processDataRetention(job())).resolves.toBeUndefined();
  });
});

describe('audit', () => {
  it('records the count and the policy, never the orders', async () => {
    batches(1, 7);

    await processDataRetention(job());

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-1',
        action: 'compliance.retention_enforced',
        actor: 'cron',
        after: { ordersRedacted: 7, retentionDays: 365 },
      }),
    );
  });

  /**
   * Naming the orders would recreate, in a table the app keeps indefinitely,
   * the very records the sweep exists to strip.
   */
  it('writes no audit row when nothing expired', async () => {
    await processDataRetention(job());

    expect(record).not.toHaveBeenCalled();
  });
});

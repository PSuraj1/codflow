import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Job ids.
 *
 * This file exists because of one production failure that nothing else would
 * have caught. BullMQ v5 rejects a custom job id containing `:` — `queue.add`
 * throws "Custom Id cannot contain :" — and every enqueue helper built ids like
 * `push:<orderId>`. So every enqueue threw, on every call.
 *
 * It was invisible for the worst possible reason: each helper deliberately
 * swallows its own errors, because a queue outage must never fail a submission
 * the shopper has already completed. Orders were stored, shoppers saw a success
 * screen, and *nothing* was pushed to Shopify, synced to Sheets, fraud-scored or
 * reported to a pixel. The fail-safe hid a total outage of every background job.
 *
 * The tests below assert the two properties that matter: an id BullMQ will
 * accept, and one that still deduplicates.
 */

const { add, addBulk, getJob } = vi.hoisted(() => ({
  add: vi.fn(),
  addBulk: vi.fn(),
  getJob: vi.fn(),
}));

/** Mirrors BullMQ's own guard, so a bad id fails here the way it does there. */
class FakeQueue {
  async add(_name: string, _data: unknown, options?: { jobId?: string }) {
    if (options?.jobId?.includes(':')) throw new Error('Custom Id cannot contain :');
    add(_name, _data, options);
    return { id: options?.jobId ?? 'generated' };
  }

  async addBulk(jobs: Array<{ opts?: { jobId?: string } }>) {
    for (const job of jobs) {
      if (job.opts?.jobId?.includes(':')) throw new Error('Custom Id cannot contain :');
    }
    addBulk(jobs);
    return jobs.map((job) => ({ id: job.opts?.jobId ?? 'generated' }));
  }

  async getJob(id: string) {
    return getJob(id) as unknown;
  }

  on(): void {}
  async close(): Promise<void> {}
}

vi.mock('bullmq', () => ({ Queue: FakeQueue }));
vi.mock('../redis', () => ({ queueConnection: {} }));

const {
  enqueueOrderPush,
  enqueueSheetSync,
  enqueueSheetSyncBulk,
  enqueueFraudScan,
  enqueuePixelEvent,
  enqueueStatsRebuild,
} = await import('./queues');

beforeEach(() => {
  vi.clearAllMocks();
});

/** The id BullMQ was given, or null when the enqueue was swallowed. */
function lastJobId(): string | null {
  const call = add.mock.calls.at(-1);
  return (call?.[2] as { jobId?: string } | undefined)?.jobId ?? null;
}

describe('every enqueue helper produces an id BullMQ accepts', () => {
  it('order push', async () => {
    const id = await enqueueOrderPush({ codOrderId: 'ckorder123', shopDomain: 'demo.myshopify.com' });

    // A null return means the helper caught an error and gave up silently —
    // which is exactly how this bug hid for so long.
    expect(id).not.toBeNull();
    expect(lastJobId()).toBe('push-ckorder123');
  });

  it('sheet sync', async () => {
    await enqueueSheetSync({ codOrderId: 'ckorder123', shopDomain: 'demo.myshopify.com' });
    expect(lastJobId()).toBe('sheet-ckorder123');
  });

  it('fraud scan', async () => {
    await enqueueFraudScan({ codOrderId: 'ckorder123', shopDomain: 'demo.myshopify.com' });
    expect(lastJobId()).toBe('fraud-ckorder123');
  });

  it('pixel event', async () => {
    await enqueuePixelEvent({
      codOrderId: 'ckorder123',
      shopDomain: 'demo.myshopify.com',
      eventName: 'PURCHASE',
    });

    expect(lastJobId()).toBe('pixel-ckorder123-PURCHASE');
  });

  it('stats rebuild', async () => {
    await enqueueStatsRebuild({
      shopId: 'shop1',
      shopDomain: 'demo.myshopify.com',
      from: '2026-03-01',
      to: '2026-03-31',
    });

    expect(lastJobId()).toBe('stats-shop1-2026-03-01-2026-03-31');
  });

  it('bulk sheet sync', async () => {
    const count = await enqueueSheetSyncBulk('demo.myshopify.com', ['a1', 'b2']);

    expect(count).toBe(2);
    expect(addBulk.mock.calls[0]?.[0]).toMatchObject([
      { opts: { jobId: 'sheet-a1' } },
      { opts: { jobId: 'sheet-b2' } },
    ]);
  });
});

describe('deduplication survives the id change', () => {
  it('gives one order the same id every time', async () => {
    await enqueueOrderPush({ codOrderId: 'ckorder123', shopDomain: 'demo.myshopify.com' });
    const first = lastJobId();

    await enqueueOrderPush({ codOrderId: 'ckorder123', shopDomain: 'demo.myshopify.com' });

    // Stability is the whole point: BullMQ treats a repeated id as a no-op, and
    // that is what stops a double-submit becoming two Shopify orders for one
    // customer — which the merchant only discovers when they ship both.
    expect(lastJobId()).toBe(first);
  });

  it('keeps different orders apart', async () => {
    await enqueueOrderPush({ codOrderId: 'aaa', shopDomain: 'demo.myshopify.com' });
    const first = lastJobId();

    await enqueueOrderPush({ codOrderId: 'bbb', shopDomain: 'demo.myshopify.com' });

    expect(lastJobId()).not.toBe(first);
  });

  it('separates a pixel event by name, so Purchase and Lead are distinct jobs', async () => {
    await enqueuePixelEvent({ codOrderId: 'x', shopDomain: 'd.myshopify.com', eventName: 'PURCHASE' });
    const purchase = lastJobId();

    await enqueuePixelEvent({ codOrderId: 'x', shopDomain: 'd.myshopify.com', eventName: 'LEAD' });

    expect(lastJobId()).not.toBe(purchase);
  });
});

describe('cancelOrderPush', () => {
  it('looks the job up by the same key it was created with', async () => {
    const { cancelOrderPush } = await import('./queues');

    getJob.mockResolvedValue(null);
    await cancelOrderPush('ckorder123');

    // A mismatch here would silently fail to cancel, and a cancelled order
    // would still be delivered to Shopify.
    expect(getJob).toHaveBeenCalledWith('push-ckorder123');
  });
});

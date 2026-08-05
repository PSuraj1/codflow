import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rescan processor.
 *
 * Its asymmetry is the thing worth pinning: a rescan can move an order in both
 * directions, but only one of them needs the queue.
 *
 *  - Tightening is free. The push gates re-read `riskAction` on every attempt,
 *    so writing a stricter verdict is enough to stop an order.
 *  - Relaxing is not. A held order was never enqueued in the first place, so
 *    releasing it means enqueueing the push here — otherwise it sits in review
 *    forever with nothing left holding it.
 */

const { rescanOrder, findById, appendEvent, shouldEnqueue, enqueueOrderPush } = vi.hoisted(() => ({
  rescanOrder: vi.fn(),
  findById: vi.fn(),
  appendEvent: vi.fn(),
  shouldEnqueue: vi.fn(),
  enqueueOrderPush: vi.fn(),
}));

vi.mock('../modules/fraud/service', () => ({ rescanOrder }));
vi.mock('../modules/orders/repository', () => ({ findById, appendEvent }));
vi.mock('../modules/orders/gates', () => ({ shouldEnqueue }));
vi.mock('../queue/queues', () => ({ enqueueOrderPush }));

const { processFraudScan } = await import('./scanOrder');

function job(codOrderId = 'order-1'): Job<{ codOrderId: string; shopDomain: string }> {
  return {
    data: { codOrderId, shopDomain: 'demo.myshopify.com' },
    attemptsMade: 0,
  } as Job<{ codOrderId: string; shopDomain: string }>;
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    shopId: 'shop-1',
    riskAction: 'REVIEW',
    shopifyOrderGid: null,
    ...overrides,
  };
}

function outcome(action: string, score = 10) {
  return { assessment: { action, score, level: 'LOW', signals: [] }, assessmentId: 'a1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue(order());
  rescanOrder.mockResolvedValue(outcome('REVIEW'));
  appendEvent.mockResolvedValue({ id: 'e1' });
  shouldEnqueue.mockReturnValue(true);
  enqueueOrderPush.mockResolvedValue('job-1');
});

describe('skipping', () => {
  it('does nothing when the order no longer exists', async () => {
    findById.mockResolvedValue(null);

    await processFraudScan(job());

    expect(rescanOrder).not.toHaveBeenCalled();
  });

  /**
   * Re-scoring a shipped order changes a number nobody can act on, and could
   * contradict a decision the merchant has already carried out.
   */
  it('does not rescan an order already in Shopify', async () => {
    findById.mockResolvedValue(order({ shopifyOrderGid: 'gid://shopify/Order/1' }));

    await processFraudScan(job());

    expect(rescanOrder).not.toHaveBeenCalled();
  });
});

describe('unchanged verdict', () => {
  it('records nothing when the decision is the same', async () => {
    findById.mockResolvedValue(order({ riskAction: 'REVIEW' }));
    rescanOrder.mockResolvedValue(outcome('REVIEW'));

    await processFraudScan(job());

    // A rescan that changes nothing should leave no trace on the timeline —
    // otherwise every settings save would bury the real history.
    expect(appendEvent).not.toHaveBeenCalled();
    expect(enqueueOrderPush).not.toHaveBeenCalled();
  });
});

describe('tightening', () => {
  it('records the change without touching the queue', async () => {
    findById.mockResolvedValue(order({ riskAction: 'ALLOW' }));
    rescanOrder.mockResolvedValue(outcome('BLOCK', 95));

    await processFraudScan(job());

    expect(appendEvent).toHaveBeenCalledWith(
      'order-1',
      'risk.rescanned',
      expect.stringContaining('ALLOW to BLOCK'),
      'system',
      expect.objectContaining({ previousAction: 'ALLOW', nextAction: 'BLOCK' }),
    );

    // Nothing to enqueue — the gates will refuse it on the next attempt.
    expect(enqueueOrderPush).not.toHaveBeenCalled();
  });
});

describe('releasing', () => {
  it('enqueues the push when an order is released', async () => {
    findById
      .mockResolvedValueOnce(order({ riskAction: 'REVIEW' }))
      // Re-read after the verdict is written, so the gates see current state.
      .mockResolvedValueOnce(order({ riskAction: 'ALLOW' }));

    rescanOrder.mockResolvedValue(outcome('ALLOW', 5));

    await processFraudScan(job());

    expect(enqueueOrderPush).toHaveBeenCalledWith({
      codOrderId: 'order-1',
      shopDomain: 'demo.myshopify.com',
    });
  });

  /**
   * The case that makes the re-read necessary: fraud is no longer holding the
   * order, but OTP still is. Enqueueing here would put a job in the queue that
   * the gates immediately refuse, burning an attempt each time.
   */
  it('does not enqueue when another gate still holds the order', async () => {
    findById
      .mockResolvedValueOnce(order({ riskAction: 'REVIEW' }))
      .mockResolvedValueOnce(order({ riskAction: 'ALLOW', otpRequired: true, otpVerified: false }));

    rescanOrder.mockResolvedValue(outcome('ALLOW'));
    shouldEnqueue.mockReturnValue(false);

    await processFraudScan(job());

    expect(enqueueOrderPush).not.toHaveBeenCalled();
  });

  it('does not enqueue when the verdict is still not ALLOW', async () => {
    findById.mockResolvedValue(order({ riskAction: 'BLOCK' }));
    rescanOrder.mockResolvedValue(outcome('REVIEW'));

    await processFraudScan(job());

    expect(enqueueOrderPush).not.toHaveBeenCalled();
  });
});

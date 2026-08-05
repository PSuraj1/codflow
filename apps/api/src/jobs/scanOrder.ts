import { RiskAction } from '@prisma/client';
import type { Job } from 'bullmq';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import * as fraudService from '../modules/fraud/service';
import * as orderRepository from '../modules/orders/repository';
import { shouldEnqueue } from '../modules/orders/gates';
import { enqueueOrderPush } from '../queue/queues';
import type { JobPayloads, QueueName } from '../queue/types';

const log = createLogger('job:fraud-scan');

type FraudScanJob = JobPayloads[typeof QueueName.FRAUD_SCAN];

/**
 * Re-scores an existing order.
 *
 * Runs after a merchant changes a rule, a threshold or a block list entry. The
 * asymmetry worth understanding is that a rescan can move an order in *both*
 * directions, and only one of them is automatic:
 *
 *  - **Tightened** — a new blacklist entry catches an order already waiting to
 *    be pushed. The gates read `riskAction` fresh on every attempt, so writing
 *    the new verdict is enough to stop it; nothing needs to chase the queue.
 *  - **Relaxed** — a merchant deletes a rule that was holding orders in review.
 *    Those orders were never enqueued (a held order does not occupy a queue
 *    slot), so releasing them means enqueueing the push here. Without this step
 *    they would sit in review forever with nothing left holding them.
 */
export async function processFraudScan(job: Job<FraudScanJob>): Promise<void> {
  const { codOrderId, shopDomain } = job.data;

  const order = await orderRepository.findById(codOrderId);

  if (!order) {
    // Redacted or deleted between enqueue and execution.
    log.info({ codOrderId }, 'Order no longer exists — nothing to rescan');
    return;
  }

  if (order.shopifyOrderGid) {
    // Already in Shopify. Re-scoring it would change a number the merchant sees
    // without changing anything that can act on it, and could contradict an
    // order they have already shipped.
    log.debug({ codOrderId }, 'Order already pushed — skipping rescan');
    return;
  }

  const previousAction = order.riskAction;
  const outcome = await fraudService.rescanOrder(order, shopDomain);
  const nextAction = outcome.assessment.action;

  if (previousAction === nextAction) return;

  await orderRepository.appendEvent(
    order.id,
    'risk.rescanned',
    `Rescan changed the decision from ${previousAction} to ${nextAction} (score ${outcome.assessment.score}).`,
    'system',
    {
      previousAction,
      nextAction,
      score: outcome.assessment.score,
      level: outcome.assessment.level,
    },
  );

  log.info(
    { codOrderId, previousAction, nextAction, score: outcome.assessment.score },
    'Rescan changed an order’s risk decision',
  );

  /**
   * Newly released. `shouldEnqueue` re-reads the gates against the order as it
   * now stands — including OTP state, which a fraud rescan does not touch — so
   * an order relaxed from REVIEW but still awaiting verification stays held.
   */
  if (nextAction === RiskAction.ALLOW) {
    const refreshed = await orderRepository.findById(order.id);

    if (refreshed && shouldEnqueue(refreshed)) {
      await enqueueOrderPush({ codOrderId: order.id, shopDomain });
      log.info({ codOrderId }, 'Order released by a rescan and queued for Shopify');
    }
  }
}

/** Logged and dropped: a failed rescan leaves the previous verdict in place. */
export function onFraudScanFailed(job: Job<FraudScanJob> | undefined, error: Error): void {
  if (!job) return;

  log.error(
    { err: toError(error), codOrderId: job.data.codOrderId, attempt: job.attemptsMade },
    'Fraud rescan failed — the previous decision still stands',
  );
}

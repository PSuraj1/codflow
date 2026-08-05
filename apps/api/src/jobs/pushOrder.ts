import type { Job } from 'bullmq';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import { markPushExhausted, pushOrder } from '../modules/orders/push';
import type { OrderPushJob } from '../queue/types';

const log = createLogger('job:order-push');

/**
 * Processor for the order-push queue.
 *
 * Thin by design: it binds a BullMQ job to the push service and translates
 * BullMQ's retry lifecycle into order state. The push logic itself stays in
 * `modules/orders/push.ts`, where it can be exercised without a queue, a Redis
 * or a worker process.
 */
export async function processOrderPush(job: Job<OrderPushJob>): Promise<void> {
  const { codOrderId, shopDomain } = job.data;

  log.info(
    { codOrderId, shop: shopDomain, attempt: job.attemptsMade + 1 },
    'Processing order push',
  );

  const result = await pushOrder(codOrderId);

  if (result.gated) {
    // A gate is not a failure. The order is waiting on a merchant decision, an
    // OTP, or is already in Shopify — none of which a retry can change, so the
    // job completes rather than burning attempts against a condition only
    // something outside the queue can clear.
    log.info({ codOrderId, gated: result.gated }, 'Order push gated — completing without retry');
  }
}

/**
 * Called when a job has exhausted every attempt.
 *
 * This is the only place an order is marked permanently failed. Doing it inside
 * the processor would flag orders that were about to succeed on their next
 * attempt, and a merchant watching their dashboard would see failures that
 * silently corrected themselves.
 */
export async function onOrderPushFailed(
  job: Job<OrderPushJob> | undefined,
  error: Error,
): Promise<void> {
  if (!job) return;

  const attemptsAllowed = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= attemptsAllowed;

  log.error(
    {
      err: error,
      codOrderId: job.data.codOrderId,
      shop: job.data.shopDomain,
      attempt: job.attemptsMade,
      exhausted,
    },
    exhausted ? 'Order push failed permanently' : 'Order push failed, will retry',
  );

  if (!exhausted) return;

  try {
    await markPushExhausted(job.data.codOrderId, error.message);
  } catch (markError) {
    log.error(
      { err: toError(markError), codOrderId: job.data.codOrderId },
      'Could not record the terminal push failure',
    );
  }
}

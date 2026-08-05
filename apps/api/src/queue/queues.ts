import { Queue, type JobsOptions } from 'bullmq';
import { config } from '../config/env';
import { queueConnection } from '../redis';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import { JobName, QueueName, type JobPayloads, type OrderPushJob } from './types';

const log = createLogger('queue');

/**
 * Queue definitions and the enqueue surface.
 *
 * Every queue shares the same retry policy, and the choice of policy matters
 * more than it looks. Shopify throttles by query cost and returns 429 under
 * load; a fixed-delay retry lands the whole backlog in the same second and gets
 * throttled again. Exponential backoff spreads it, and BullMQ's jitter keeps
 * two replicas from retrying in lockstep.
 *
 * `removeOnComplete` is bounded rather than `true`: keeping the last 1000
 * successes is what lets an operator confirm a job actually ran during an
 * incident, without letting Redis grow without limit. Failures are kept far
 * longer — they are the ones anyone ever looks at.
 */

const defaultJobOptions: JobsOptions = {
  attempts: config.queue.maxAttempts,
  backoff: { type: 'exponential', delay: config.queue.backoffMs },
  removeOnComplete: { count: 1_000, age: 24 * 3_600 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 3_600 },
};

/**
 * Builds a deduplicating job id.
 *
 * **BullMQ v5 rejects a custom job id containing `:`** — `queue.add` throws
 * "Custom Id cannot contain :" — because the colon is its own key separator in
 * Redis. Every enqueue helper here used to build ids like `push:<orderId>`, so
 * every one of them threw, on every call.
 *
 * That failure was invisible. Each helper swallows its own errors on purpose —
 * a queue outage must not fail a submission the shopper has already completed —
 * so orders were saved, shoppers saw success, and nothing was ever pushed to
 * Shopify, synced to Sheets, scored for fraud or reported to a pixel. The
 * fail-safe hid a total outage of every background job in the app.
 *
 * A hyphen separates instead. The id still has to be stable and unique per unit
 * of work, because that is what makes a double-submit collapse into one job.
 */
function jobKey(...parts: string[]): string {
  return parts.map((part) => part.replace(/:/g, '-')).join('-');
}

/** BullMQ namespaces its own keys; the app prefix keeps environments apart. */
const prefix = `${config.redis.prefix}:bull`;

declare global {
  // eslint-disable-next-line no-var
  var __codflowQueues: Map<string, Queue> | undefined;
}

/**
 * Queues are cached on the global under `tsx watch`, for the same reason the
 * Prisma client is: a reload would otherwise leak a Redis connection per queue
 * on every file save.
 */
const registry: Map<string, Queue> = globalThis.__codflowQueues ?? new Map();

if (!config.isProduction) {
  globalThis.__codflowQueues = registry;
}

function getQueue<T extends QueueName>(name: T): Queue<JobPayloads[T]> {
  const existing = registry.get(name);
  if (existing) return existing as Queue<JobPayloads[T]>;

  const queue = new Queue<JobPayloads[T]>(name, {
    connection: queueConnection,
    prefix,
    defaultJobOptions,
  });

  queue.on('error', (error: Error) => {
    log.error({ err: error, queue: name }, 'Queue error');
  });

  registry.set(name, queue);
  return queue;
}

/**
 * Enqueues a Shopify order push.
 *
 * The job id is derived from the order id, and BullMQ treats a duplicate id as
 * a no-op. That is the deduplication that matters here: the submission path,
 * an OTP verification and a merchant's manual retry can all reach this for the
 * same order, and pushing an order twice would create two Shopify orders for
 * one customer — which the merchant discovers when they ship both.
 *
 * A completed job's id is released when it is removed, so a genuine retry after
 * a failure still enqueues.
 */
export async function enqueueOrderPush(
  payload: OrderPushJob,
  options: { delayMs?: number } = {},
): Promise<string | null> {
  try {
    const job = await getQueue(QueueName.ORDER_PUSH).add(JobName.PUSH_ORDER, payload, {
      jobId: jobKey('push', payload.codOrderId),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    });

    log.info({ codOrderId: payload.codOrderId, jobId: job.id }, 'Order push enqueued');
    return job.id ?? null;
  } catch (error) {
    // Enqueue failure must not fail the shopper's submission — the order is
    // already durably stored, and a merchant retry (or the stuck-order sweep)
    // can push it later. Logged at error because it needs attention.
    log.error(
      { err: toError(error), codOrderId: payload.codOrderId },
      'Could not enqueue order push — order is stored but not queued',
    );
    return null;
  }
}

/**
 * Enqueues a Google Sheets sync.
 *
 * Keyed on the order id like the push, so the three paths that can reach it —
 * a successful push, a merchant's manual retry, a backfill — collapse to one
 * job. Writing an order into a merchant's sheet twice produces a duplicate row
 * they then have to find and delete by hand.
 */
export async function enqueueSheetSync(
  payload: JobPayloads[typeof QueueName.SHEET_SYNC],
  options: { delayMs?: number } = {},
): Promise<string | null> {
  try {
    const job = await getQueue(QueueName.SHEET_SYNC).add(JobName.SYNC_ORDER, payload, {
      jobId: jobKey('sheet', payload.codOrderId),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    });

    return job.id ?? null;
  } catch (error) {
    // Never fails the caller. The order carries `sheetSyncStatus: PENDING`, so
    // a backfill picks it up later.
    log.error(
      { err: toError(error), codOrderId: payload.codOrderId },
      'Could not enqueue sheet sync',
    );
    return null;
  }
}

/**
 * Enqueues a batch of syncs for the backfill.
 *
 * `addBulk` is one Redis round trip for the whole batch rather than one per
 * order — the difference between a few milliseconds and several seconds when a
 * merchant backfills five hundred orders.
 */
export async function enqueueSheetSyncBulk(
  shopDomain: string,
  codOrderIds: readonly string[],
): Promise<number> {
  if (codOrderIds.length === 0) return 0;

  try {
    const jobs = await getQueue(QueueName.SHEET_SYNC).addBulk(
      codOrderIds.map((codOrderId) => ({
        name: JobName.SYNC_ORDER,
        data: { codOrderId, shopDomain },
        opts: { jobId: jobKey('sheet', codOrderId) },
      })),
    );

    log.info({ shop: shopDomain, count: jobs.length }, 'Sheet sync backlog enqueued');
    return jobs.length;
  } catch (error) {
    log.error({ err: toError(error), shop: shopDomain }, 'Could not enqueue the sheet backlog');
    return 0;
  }
}

/**
 * Enqueues a fraud rescan.
 *
 * Deduplicated per order like the others, so a merchant editing three rules in
 * quick succession queues one rescan per order rather than three.
 */
export async function enqueueFraudScan(
  payload: JobPayloads[typeof QueueName.FRAUD_SCAN],
): Promise<string | null> {
  try {
    const job = await getQueue(QueueName.FRAUD_SCAN).add(JobName.SCAN_ORDER, payload, {
      jobId: jobKey('fraud', payload.codOrderId),
    });
    return job.id ?? null;
  } catch (error) {
    log.error({ err: toError(error), codOrderId: payload.codOrderId }, 'Could not enqueue a rescan');
    return null;
  }
}

/**
 * Re-scores a batch of orders after a rule or block list change.
 *
 * `addBulk` is one Redis round trip for the whole set. The batch matters
 * because the common case is a merchant adding one blacklist entry and
 * expecting it to catch the orders already sitting in review — re-scoring them
 * one request at a time would take longer than they will wait.
 */
export async function enqueueFraudScanBulk(
  shopDomain: string,
  codOrderIds: readonly string[],
): Promise<number> {
  if (codOrderIds.length === 0) return 0;

  try {
    const jobs = await getQueue(QueueName.FRAUD_SCAN).addBulk(
      codOrderIds.map((codOrderId) => ({
        name: JobName.SCAN_ORDER,
        data: { codOrderId, shopDomain },
        opts: { jobId: jobKey('fraud', codOrderId) },
      })),
    );

    log.info({ shop: shopDomain, count: jobs.length }, 'Fraud rescan batch enqueued');
    return jobs.length;
  } catch (error) {
    log.error({ err: toError(error), shop: shopDomain }, 'Could not enqueue the rescan batch');
    return 0;
  }
}

/**
 * Enqueues a server-side pixel event.
 *
 * The job id includes the event name, so an order's InitiateCheckout and its
 * Purchase are separate jobs while a duplicate of either collapses. Sending one
 * Purchase twice teaches the ad platform to bid on a conversion that never
 * happened, so the deduplication matters more here than anywhere else in the
 * app.
 */
export async function enqueuePixelEvent(
  payload: JobPayloads[typeof QueueName.PIXEL_DISPATCH],
): Promise<string | null> {
  try {
    const job = await getQueue(QueueName.PIXEL_DISPATCH).add(JobName.DISPATCH_EVENT, payload, {
      jobId: jobKey('pixel', payload.codOrderId, payload.eventName),
    });
    return job.id ?? null;
  } catch (error) {
    // Never fails the caller. A missed conversion event is a reporting gap, not
    // a broken order.
    log.error(
      { err: toError(error), codOrderId: payload.codOrderId, event: payload.eventName },
      'Could not enqueue a pixel event',
    );
    return null;
  }
}

/**
 * Enqueues an analytics rebuild.
 *
 * The job id is the shop and the window, so a merchant who clicks twice gets
 * one rebuild rather than two racing transactions deleting and re-inserting the
 * same rows — which would leave whichever finished second as the survivor and
 * could briefly show an empty dashboard in between.
 */
export async function enqueueStatsRebuild(
  payload: JobPayloads[typeof QueueName.STATS_REBUILD],
): Promise<string | null> {
  try {
    const job = await getQueue(QueueName.STATS_REBUILD).add(JobName.REBUILD_STATS, payload, {
      jobId: jobKey('stats', payload.shopId, payload.from, payload.to),
    });
    return job.id ?? null;
  } catch (error) {
    log.error(
      { err: toError(error), shop: payload.shopDomain, from: payload.from, to: payload.to },
      'Could not enqueue an analytics rebuild',
    );
    return null;
  }
}

/**
 * Installs the nightly data-retention sweep.
 *
 * `upsertJobScheduler` rather than `add({ repeat })` because it is idempotent:
 * the worker calls this on every boot, and the older repeat API would leave a
 * second scheduler behind whenever the pattern changed — two sweeps running the
 * same night, forever, with nothing in the app saying so.
 *
 * 03:00 in the worker's timezone. The sweep takes write locks on orders, and
 * doing that during a merchant's trading hours would put shopper submissions
 * behind it.
 *
 * Failure here must not stop the worker from booting. A worker that refuses to
 * start because a scheduler could not be installed stops every order push too,
 * which trades a compliance delay for an outage.
 */
export async function scheduleRetentionSweep(): Promise<void> {
  try {
    await getQueue(QueueName.DATA_RETENTION).upsertJobScheduler(
      'retention-nightly',
      { pattern: '0 3 * * *' },
      { name: JobName.ENFORCE_RETENTION, data: {} },
    );

    log.info('Data retention sweep scheduled');
  } catch (error) {
    log.error({ err: toError(error) }, 'Could not schedule the data retention sweep');
  }
}

/** Runs the retention sweep now, for tests and for an operator who needs it. */
export async function enqueueRetentionSweep(): Promise<string | null> {
  try {
    const job = await getQueue(QueueName.DATA_RETENTION).add(JobName.ENFORCE_RETENTION, {});
    return job.id ?? null;
  } catch (error) {
    log.error({ err: toError(error) }, 'Could not enqueue a retention sweep');
    return null;
  }
}

/** Removes a pending push, so a cancelled order is not delivered to Shopify. */
export async function cancelOrderPush(codOrderId: string): Promise<void> {
  try {
    const job = await getQueue(QueueName.ORDER_PUSH).getJob(jobKey('push', codOrderId));
    // An active job is mid-flight against Shopify; removing it would orphan the
    // work rather than stop it, so it is left to finish.
    if (job && !(await job.isActive())) {
      await job.remove();
      log.info({ codOrderId }, 'Pending order push cancelled');
    }
  } catch (error) {
    log.warn({ err: toError(error), codOrderId }, 'Could not cancel order push');
  }
}

/** Queue depths, for the dashboard and the readiness probe. */
export async function queueCounts(name: QueueName) {
  const queue = getQueue(name);
  return queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...registry.values()].map((queue) => queue.close()));
  registry.clear();
  log.info('Queues closed');
}

export { QueueName };

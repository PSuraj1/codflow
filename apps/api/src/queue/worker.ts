import { Worker, type Job } from 'bullmq';
import { config } from '../config/env';
import { createLogger, logger } from '../lib/logger';
import { checkDatabaseConnection, disconnectDatabase } from '../db/prisma';
import { checkRedisConnection, disconnectRedis, queueConnection } from '../redis';
import { close as closeMailer } from '../lib/mailer';
import { toError } from '../lib/errors';
import { onOrderPushFailed, processOrderPush } from '../jobs/pushOrder';
import { processSheetSync } from '../jobs/syncSheet';
import { onFraudScanFailed, processFraudScan } from '../jobs/scanOrder';
import { onPixelDispatchFailed, processPixelDispatch } from '../jobs/dispatchPixel';
import { onStatsRebuildFailed, processStatsRebuild } from '../jobs/rebuildStats';
import { onDataRetentionFailed, processDataRetention } from '../jobs/enforceRetention';
import { closeQueues, scheduleRetentionSweep } from './queues';
import { migratePermanentTokens } from '../shopify/sessionStorage';
import { QueueName, type JobPayloads, type OrderPushJob } from './types';

const log = createLogger('worker');

/**
 * The background worker process.
 *
 * Runs separately from the web process — `node dist/queue/worker.js` — because
 * the two scale on different pressures. Web capacity is driven by concurrent
 * shoppers; worker capacity by how fast Shopify will accept writes. Sharing one
 * process means a backlog of pushes competes with request handling for the same
 * event loop, and merchants see slow product pages during their own busy hour.
 *
 * Running both from one image with different commands is deliberate: identical
 * code, identical migrations, no second deployment pipeline to keep in step.
 */

const prefix = `${config.redis.prefix}:bull`;
const workers: Worker[] = [];
let shuttingDown = false;

function registerWorker<T>(
  name: string,
  processor: (job: Job<T>) => Promise<void>,
  options: { concurrency?: number } = {},
): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection: queueConnection,
    prefix,
    concurrency: options.concurrency ?? config.queue.concurrency,
    /**
     * A job whose process dies mid-flight is only reclaimed after this window.
     * 30 seconds is comfortably longer than any Shopify call plus its retries,
     * and short enough that a crashed worker's jobs resume quickly. Too low and
     * a slow-but-healthy job is stolen by another worker and runs twice.
     */
    stalledInterval: 30_000,
    maxStalledCount: 2,
  });

  worker.on('completed', (job) => {
    log.debug({ queue: name, jobId: job.id }, 'Job completed');
  });

  worker.on('error', (error) => {
    log.error({ err: error, queue: name }, 'Worker error');
  });

  workers.push(worker as unknown as Worker);
  return worker;
}

async function start(): Promise<void> {
  const [database, redis] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  if (!database) throw new Error('Cannot reach the database');
  if (!redis) throw new Error('Cannot reach Redis');

  const orderPush = registerWorker<OrderPushJob>(QueueName.ORDER_PUSH, processOrderPush);
  orderPush.on('failed', (job, error) => void onOrderPushFailed(job, error));

  /**
   * Sheets runs at lower concurrency than the rest.
   *
   * Google's Sheets API allows roughly 60 write requests per minute per user,
   * and every one of a merchant's syncs shares that single budget. Running at
   * the default concurrency would spend the whole quota in seconds and put the
   * entire backlog into exponential backoff — slower overall than pacing it.
   */
  registerWorker<JobPayloads[typeof QueueName.SHEET_SYNC]>(
    QueueName.SHEET_SYNC,
    processSheetSync,
    { concurrency: Math.min(config.queue.concurrency, 3) },
  );

  /**
   * Rescans are database-only and cheap, but a bulk re-score can enqueue
   * hundreds at once. Capping the concurrency keeps that batch from saturating
   * the connection pool the web process shares.
   */
  const fraudScan = registerWorker<JobPayloads[typeof QueueName.FRAUD_SCAN]>(
    QueueName.FRAUD_SCAN,
    processFraudScan,
    { concurrency: Math.min(config.queue.concurrency, 5) },
  );
  fraudScan.on('failed', (job, error) => onFraudScanFailed(job, error));

  /**
   * Pixel dispatch fans out to every configured provider concurrently, so one
   * job is already several outbound HTTP calls. Running these at the full
   * default concurrency would put dozens of simultaneous requests on ad
   * platforms that rate-limit per account.
   */
  const pixelDispatch = registerWorker<JobPayloads[typeof QueueName.PIXEL_DISPATCH]>(
    QueueName.PIXEL_DISPATCH,
    processPixelDispatch,
    { concurrency: Math.min(config.queue.concurrency, 5) },
  );
  pixelDispatch.on('failed', (job, error) => onPixelDispatchFailed(job, error));

  /**
   * Rebuilds run one at a time. Each one deletes and re-inserts a shop's
   * aggregates for a window, and two overlapping windows for the same shop
   * would race to be the survivor. Serialising them costs nothing — this is an
   * operator-initiated job that runs a handful of times in a shop's lifetime.
   */
  const statsRebuild = registerWorker<JobPayloads[typeof QueueName.STATS_REBUILD]>(
    QueueName.STATS_REBUILD,
    processStatsRebuild,
    { concurrency: 1 },
  );
  statsRebuild.on('failed', (job, error) => onStatsRebuildFailed(job, error));

  /**
   * The retention sweep runs alone. It takes write locks on orders across every
   * shop, and a second copy running concurrently would contend with the first
   * for the same rows to redo work already done.
   */
  const dataRetention = registerWorker<JobPayloads[typeof QueueName.DATA_RETENTION]>(
    QueueName.DATA_RETENTION,
    processDataRetention,
    { concurrency: 1 },
  );
  dataRetention.on('failed', (job, error) => onDataRetentionFailed(job, error));

  // After the workers exist, so the first sweep has something to run it. Never
  // throws — see `scheduleRetentionSweep`.
  await scheduleRetentionSweep();

  // Shopify refuses calls made with the deprecated permanent offline tokens, so
  // a shop still holding one is broken until it is migrated. Every path that
  // loads a session migrates on demand; this catches the shop nothing has
  // touched yet. Never throws — see `migratePermanentTokens`.
  const migrated = await migratePermanentTokens();

  log.info(
    {
      queues: workers.length,
      concurrency: config.queue.concurrency,
      env: config.env,
      ...(migrated > 0 ? { migratedTokens: migrated } : {}),
    },
    'CODkar worker started',
  );
}

/**
 * Drains before exiting.
 *
 * `worker.close()` waits for in-flight jobs to finish rather than killing them.
 * That matters most for the order push: a job interrupted between creating a
 * draft and completing it leaves an order half-written into Shopify, and while
 * the retry does resume from the persisted draft id, finishing cleanly avoids
 * the situation entirely.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info({ signal }, 'Worker shutting down');

  const forceExit = setTimeout(() => {
    log.error('Worker shutdown timed out — forcing exit');
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  try {
    await Promise.allSettled(workers.map((worker) => worker.close()));
    await closeQueues();
    await closeMailer();
    await disconnectDatabase();
    await disconnectRedis();

    clearTimeout(forceExit);
    log.info('Worker shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ err: toError(error) }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason: unknown) => {
  logger.fatal({ err: toError(reason) }, 'Unhandled rejection in worker');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error: Error) => {
  logger.fatal({ err: error }, 'Uncaught exception in worker');
  void shutdown('uncaughtException');
});

start().catch((error: unknown) => {
  logger.fatal({ err: toError(error) }, 'Failed to start the CODkar worker');
  process.exit(1);
});

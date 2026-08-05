import type { Job } from 'bullmq';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import { addDays, daysBetween } from '../lib/shopTime';
import { rebuild } from '../modules/analytics/service';
import type { JobPayloads, QueueName } from '../queue/types';

const log = createLogger('job:stats-rebuild');

type RebuildJob = JobPayloads[typeof QueueName.STATS_REBUILD];

/**
 * How much of a rebuild happens in one transaction.
 *
 * A rebuild deletes and re-inserts every row in its window, so the window is
 * also the transaction. A year in one go holds locks on 365 rows while it reads
 * every order of the year — long enough to matter on a busy shop. Chunking by
 * month keeps each transaction short, and because each chunk is independently
 * correct, a failure part-way leaves the finished months rebuilt rather than
 * rolling back work that was fine.
 */
const CHUNK_DAYS = 31;

/**
 * Processor for the analytics rebuild queue.
 *
 * The reconciliation path for the whole dashboard. Incremental counters drift
 * for reasons that are not bugs — a webhook Shopify retried after the handler
 * had already run, a deploy that dropped an in-flight increment — and this is
 * how a merchant gets their numbers back without anyone touching the database.
 */
export async function processStatsRebuild(job: Job<RebuildJob>): Promise<void> {
  const { shopId, shopDomain, from, to } = job.data;
  const total = daysBetween(from, to);

  log.info({ shop: shopDomain, from, to, days: total }, 'Rebuilding analytics');

  let cursor = from;
  let rebuiltDays = 0;

  while (cursor <= to) {
    const chunkEnd = addDays(cursor, CHUNK_DAYS - 1);
    const end = chunkEnd > to ? to : chunkEnd;

    rebuiltDays += await rebuild(shopId, cursor, end);

    // Reported so a long rebuild is visibly progressing in Bull Board rather
    // than looking hung for several minutes.
    await job.updateProgress(Math.round((daysBetween(from, end) / total) * 100));

    cursor = addDays(end, 1);
  }

  log.info(
    { shop: shopDomain, from, to, daysWritten: rebuiltDays },
    'Analytics rebuild complete',
  );
}

/**
 * Logged and dropped once retries are exhausted.
 *
 * A failed rebuild leaves the previous aggregates in place — the merchant sees
 * stale numbers rather than none — and can be re-run at any time.
 */
export function onStatsRebuildFailed(job: Job<RebuildJob> | undefined, error: Error): void {
  if (!job) return;

  const attemptsAllowed = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= attemptsAllowed;

  log.error(
    {
      err: toError(error),
      shop: job.data.shopDomain,
      from: job.data.from,
      to: job.data.to,
      attempt: job.attemptsMade,
      exhausted,
    },
    exhausted
      ? 'Analytics rebuild failed — stored aggregates are unchanged and can be rebuilt again'
      : 'Analytics rebuild failed, will retry',
  );
}

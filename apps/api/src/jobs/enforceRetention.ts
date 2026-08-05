import type { Job } from 'bullmq';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import * as shopRepository from '../modules/shop/repository';
import * as audit from '../modules/audit/service';
import type { JobPayloads, QueueName } from '../queue/types';

const log = createLogger('job:data-retention');

type RetentionJob = JobPayloads[typeof QueueName.DATA_RETENTION];

/**
 * Data retention.
 *
 * Shopify's protected customer data rules require that personal data is not
 * kept longer than it is needed, and until this existed CodFlow kept a
 * shopper's name, phone and address for as long as the merchant stayed
 * installed. A privacy policy claiming a retention limit while nothing enforced
 * one would have been worse than having no policy: an untrue one.
 *
 * The sweep *blanks* rather than deletes, exactly as `customers/redact` does —
 * see `shop/repository.REDACTION`, which both paths share. A merchant's revenue
 * history must not change because a retention period elapsed.
 */

/**
 * Rows cleared per statement, and the ceiling for one shop in one night.
 *
 * The batch bounds how long a single `updateMany` holds write locks that the
 * shopper-facing submission path may be queued behind. The ceiling bounds the
 * whole sweep: the first run on a shop with years of history could otherwise
 * touch every order it has, and spreading that over a few nights costs nothing
 * — the data is already past its date, so a further day is not the problem the
 * indefinite retention was.
 */
const BATCH = 500;
const MAX_PER_SHOP_PER_RUN = 20_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Processor for the nightly retention sweep.
 *
 * One shop's failure must not end the run. Each is caught and logged so the
 * remaining shops are still swept — an unhandled error part-way through would
 * leave every shop after it in the list unprocessed, and because the job is
 * scheduled rather than retried per-shop, they would simply wait another day.
 */
export async function processDataRetention(job: Job<RetentionJob>): Promise<void> {
  const shops = await shopRepository.findShopsForRetentionSweep();

  log.info({ shops: shops.length }, 'Data retention sweep started');

  let sweptShops = 0;
  let totalRedacted = 0;

  for (const [index, shop] of shops.entries()) {
    try {
      const redacted = await sweepShop(shop.id, shop.settings?.orderRetentionDays);

      if (redacted > 0) {
        sweptShops += 1;
        totalRedacted += redacted;

        log.warn(
          { shop: shop.domain, orders: redacted, retentionDays: shop.settings?.orderRetentionDays },
          'Personal data cleared from orders past their retention period',
        );

        await audit.record({
          shopId: shop.id,
          action: audit.AuditAction.RETENTION_ENFORCED,
          entity: 'CodOrder',
          actor: audit.AuditActor.CRON,
          // Counts and the policy that produced them. Recording *which* orders
          // were cleared would name, in a table kept indefinitely, the records
          // this job exists to strip.
          after: { ordersRedacted: redacted, retentionDays: shop.settings?.orderRetentionDays },
        });
      }
    } catch (error) {
      log.error(
        { err: toError(error), shop: shop.domain },
        'Retention sweep failed for this shop — continuing with the rest',
      );
    }

    await job.updateProgress(Math.round(((index + 1) / Math.max(shops.length, 1)) * 100));
  }

  log.info({ shops: sweptShops, orders: totalRedacted }, 'Data retention sweep complete');
}

/**
 * Clears one shop's expired orders, a batch at a time.
 *
 * Loops because `anonymiseExpiredOrders` is bounded; it returns zero once
 * nothing is left, which is the only clean stopping condition — counting rows
 * up front would race with orders ageing past the cutoff mid-sweep.
 */
async function sweepShop(shopId: string, retentionDays: number | undefined): Promise<number> {
  // A shop mid-provisioning has no settings row yet, and therefore no orders
  // old enough to matter. Skipping is correct; inventing a default here would
  // put a second copy of that number somewhere it can drift from the schema.
  if (!retentionDays || retentionDays <= 0) return 0;

  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  let redacted = 0;

  while (redacted < MAX_PER_SHOP_PER_RUN) {
    const count = await shopRepository.anonymiseExpiredOrders(shopId, cutoff, BATCH);
    if (count === 0) break;

    redacted += count;
  }

  return redacted;
}

/**
 * Logged and dropped once retries are exhausted.
 *
 * A missed sweep is a day's delay, not data loss — the next scheduled run picks
 * up everything this one would have, because the work is defined by the cutoff
 * rather than by anything this job recorded.
 */
export function onDataRetentionFailed(job: Job<RetentionJob> | undefined, error: Error): void {
  if (!job) return;

  const attemptsAllowed = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= attemptsAllowed;

  log.error(
    { err: toError(error), attempt: job.attemptsMade, exhausted },
    exhausted
      ? 'Data retention sweep failed — the next scheduled run covers the same orders'
      : 'Data retention sweep failed, will retry',
  );
}

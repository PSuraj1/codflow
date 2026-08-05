import { SyncTrigger } from '@prisma/client';
import type { Job } from 'bullmq';
import { createLogger } from '../lib/logger';
import { syncOrder } from '../modules/sheets/sync';
import type { JobPayloads, QueueName } from '../queue/types';

const log = createLogger('job:sheet-sync');

type SheetSyncJob = JobPayloads[typeof QueueName.SHEET_SYNC];

/**
 * Processor for the sheet-sync queue.
 *
 * The trigger is inferred from the attempt count rather than carried on the
 * payload: a first attempt is whatever enqueued it, and every subsequent one is
 * a retry. Recording that distinction in the sync log is what lets a merchant
 * tell "this failed once and recovered" from "this has been failing all day".
 */
export async function processSheetSync(job: Job<SheetSyncJob>): Promise<void> {
  const { codOrderId, shopDomain } = job.data;

  const trigger = job.attemptsMade > 0 ? SyncTrigger.RETRY : SyncTrigger.WEBHOOK;

  const result = await syncOrder(codOrderId, trigger, job.id ?? null);

  if (result.skipped) {
    // Not a failure — no sheet connected, the spreadsheet is gone, or the
    // Google grant was revoked. None of those improve on retry, so the job
    // completes rather than burning attempts.
    log.info(
      { codOrderId, shop: shopDomain, reason: result.skipped },
      'Sheet sync skipped',
    );
  }
}

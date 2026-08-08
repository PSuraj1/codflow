import { SyncStatus, SyncTrigger, type CodOrder, type SheetConfig } from '@prisma/client';
import { USAGE_METRICS, type SheetColumnMapping } from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import {
  SheetTransientError,
  SheetUnavailableError,
  appendRows,
  prependRows,
  readRange,
  writeHeaderRow,
  quoteSheetName,
} from '../../google/sheets';
import * as googleService from '../google/service';
import * as stats from '../analytics/stats';
import * as billing from '../billing/service';
import * as repository from './repository';
import { buildHeaderRow, buildRows } from './rowBuilder';

const log = createLogger('sheet-sync');

/**
 * The sync engine.
 *
 * Writes one COD order into the merchant's spreadsheet. Runs in the worker, so
 * it may retry — which makes the failure taxonomy the important part of this
 * file rather than the writing itself:
 *
 *  - **Transient** (429, 5xx, network) — rethrown so BullMQ retries with
 *    backoff. Google's quota is per-minute and clears on its own.
 *  - **Unavailable** (404, 403) — the spreadsheet was deleted or un-shared.
 *    Recorded and *not* rethrown: retrying is pointless, and burning five
 *    attempts per order across a whole backlog turns one deleted sheet into
 *    thousands of doomed Google calls.
 *  - **Revoked** — the merchant's Google grant is gone. Same reasoning, plus
 *    the config is deactivated so the backlog stops rather than accumulating
 *    failures until someone notices.
 */

export interface SyncResult {
  readonly synced: boolean;
  readonly rowsWritten: number;
  readonly skipped: string | null;
}

/** Reads the mapping out of the JSON column, tolerating a malformed row. */
function readMapping(config: SheetConfig): SheetColumnMapping[] {
  if (!Array.isArray(config.columnMapping)) return [];

  return (config.columnMapping as unknown[]).flatMap((entry): SheetColumnMapping[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];

    const record = entry as Record<string, unknown>;
    if (typeof record.source !== 'string' || typeof record.column !== 'string') return [];

    return [
      {
        column: record.column,
        source: record.source,
        header: typeof record.header === 'string' ? record.header : record.source,
      },
    ];
  });
}

/**
 * Writes the header row if the sheet does not already have one.
 *
 * Checked by reading rather than by trusting a flag, because the merchant owns
 * the spreadsheet — they can clear it, delete the tab, or point CODkar at a
 * sheet somebody else set up. A stored "headers written" boolean would be wrong
 * the moment they do, and every subsequent row would land under no headings.
 */
async function ensureHeaders(
  accessToken: string,
  config: SheetConfig,
  mapping: readonly SheetColumnMapping[],
): Promise<void> {
  if (!config.includeHeaders || mapping.length === 0) return;

  const range = `${quoteSheetName(config.worksheetName)}!A${config.headerRow}:${String.fromCharCode(64 + Math.min(mapping.length, 26))}${config.headerRow}`;

  const existing = await readRange(accessToken, config.spreadsheetId, range);
  const firstRow = existing[0] ?? [];

  const isEmpty = firstRow.every((cell) => !cell || cell.trim().length === 0);

  if (!isEmpty) return;

  await writeHeaderRow(
    accessToken,
    config.spreadsheetId,
    config.worksheetName,
    buildHeaderRow(mapping),
    config.headerRow,
  );

  log.info({ spreadsheetId: config.spreadsheetId }, 'Header row written');
}

/**
 * Syncs one order.
 *
 * Returns rather than throws for conditions a retry cannot fix; throws for
 * conditions it can. The caller — a BullMQ processor — relies on exactly that
 * distinction to decide whether to schedule another attempt.
 */
export async function syncOrder(
  codOrderId: string,
  trigger: SyncTrigger,
  jobId: string | null = null,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const order = await repository.findOrder(codOrderId);

  if (!order) {
    // Redacted or deleted between enqueue and execution.
    return { synced: false, rowsWritten: 0, skipped: 'ORDER_NOT_FOUND' };
  }

  const config = await repository.findActiveConfig(order.shopId);

  if (!config) {
    // No sheet connected, or auto-sync switched off. Not a failure — most shops
    // never connect one — so the order is marked SKIPPED rather than left
    // PENDING, which would make it show up forever in the retry list.
    await repository.setOrderSyncStatus(order.id, SyncStatus.SKIPPED, null);
    return { synced: false, rowsWritten: 0, skipped: 'NO_ACTIVE_CONFIG' };
  }

  const mapping = readMapping(config);

  if (mapping.length === 0) {
    await repository.setOrderSyncStatus(order.id, SyncStatus.SKIPPED, null);
    return { synced: false, rowsWritten: 0, skipped: 'NO_COLUMN_MAPPING' };
  }

  const shop = await repository.findShopContext(order.shopId);
  const timeZone = shop?.ianaTimezone ?? shop?.timezone ?? 'UTC';

  await repository.setOrderSyncStatus(order.id, SyncStatus.IN_PROGRESS, null);

  const rows = buildRows(order, {
    mapping,
    singleRowPerOrder: config.singleRowPerOrder,
    timeZone,
  });

  try {
    const { accessToken } = await googleService.accessTokenFor(order.shopId);

    await ensureHeaders(accessToken, config, mapping);

    if (config.insertAtTop) {
      if (config.worksheetGid === null) {
        // `insertDimension` addresses a tab by numeric id, not by name. Without
        // it the prepend cannot target the right tab, so this falls back to
        // appending rather than writing into the wrong one.
        log.warn(
          { configId: config.id },
          'insertAtTop is on but the worksheet id is unknown — appending instead',
        );
        await appendRows(accessToken, config.spreadsheetId, config.worksheetName, rows);
      } else {
        await prependRows(
          accessToken,
          config.spreadsheetId,
          config.worksheetGid,
          config.worksheetName,
          rows,
          config.headerRow,
        );
      }
    } else {
      await appendRows(accessToken, config.spreadsheetId, config.worksheetName, rows);
    }

    await repository.setOrderSyncStatus(order.id, SyncStatus.SUCCESS, new Date());
    await repository.recordSuccess(config.id, rows.length);

    await repository.logSync({
      shopId: order.shopId,
      sheetConfigId: config.id,
      codOrderId: order.id,
      status: SyncStatus.SUCCESS,
      trigger,
      payload: rows as unknown as never,
      durationMs: Date.now() - startedAt,
      jobId,
    });

    await stats.recordSheetSync(order.shopId, 'success');
    await billing.recordUsage(order.shopId, USAGE_METRICS.SHEET_SYNCS);

    log.info(
      { reference: order.reference, rows: rows.length, spreadsheetId: config.spreadsheetId },
      'Order synced to Google Sheets',
    );

    return { synced: true, rowsWritten: rows.length, skipped: null };
  } catch (error) {
    const failure = toError(error);

    await repository.setOrderSyncStatus(order.id, SyncStatus.FAILED, null);
    await repository.recordFailure(config.id, failure.message);

    await repository.logSync({
      shopId: order.shopId,
      sheetConfigId: config.id,
      codOrderId: order.id,
      status: SyncStatus.FAILED,
      trigger,
      payload: rows as unknown as never,
      errorMessage: failure.message,
      errorCode: error instanceof SheetUnavailableError ? 'SHEET_UNAVAILABLE' : 'SYNC_FAILED',
      durationMs: Date.now() - startedAt,
      jobId,
    });

    await stats.recordSheetSync(order.shopId, 'failed');

    // Terminal. The spreadsheet is gone, or the grant is. Deactivating stops a
    // backlog from generating one doomed Google call per order per retry, and
    // the admin surfaces `lastError` so the merchant can see why.
    if (error instanceof SheetUnavailableError) {
      await repository.updateConfig(config.id, { isActive: false });

      log.error(
        { reference: order.reference, err: failure },
        'Spreadsheet is unreachable — sync deactivated until the merchant fixes it',
      );

      return { synced: false, rowsWritten: 0, skipped: 'SHEET_UNAVAILABLE' };
    }

    // Retriable: Google quota, a 5xx, a network blip.
    if (error instanceof SheetTransientError) {
      throw error;
    }

    // A revoked Google grant reaches here as a ConflictError from the token
    // service. Same reasoning as an unavailable sheet — retrying cannot help.
    if (failure.message.includes('Reconnect your Google account')) {
      await repository.updateConfig(config.id, { isActive: false });
      return { synced: false, rowsWritten: 0, skipped: 'GOOGLE_REVOKED' };
    }

    throw error;
  }
}

/**
 * Queues every order that is not yet in the sheet.
 *
 * The "sync existing orders" action. Bounded per call and enqueued rather than
 * written inline: a shop backfilling ten thousand orders would otherwise hold
 * one HTTP request open for the duration and hit Google's per-minute quota in
 * the first few seconds.
 */
export async function collectBacklog(shopId: string, limit = 500): Promise<CodOrder[]> {
  return repository.findUnsynced(shopId, limit);
}

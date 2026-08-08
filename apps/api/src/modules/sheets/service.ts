import type { SheetConfig } from '@prisma/client';
import {
  DEFAULT_COLUMN_MAPPING,
  columnLetter,
  isCustomFieldSource,
  sheetFieldSource,
  type SheetColumnMapping,
  type SheetConfigSummary,
  type SheetsOverview,
  type SpreadsheetSummary,
  type WorksheetSummary,
} from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { BadRequestError, NotFoundError, ValidationError } from '../../lib/errors';
import {
  addWorksheet,
  createSpreadsheet,
  getSpreadsheet,
  listSpreadsheets,
} from '../../google/sheets';
import { enqueueSheetSyncBulk } from '../../queue/queues';
import * as googleService from '../google/service';
import * as repository from './repository';
import { collectBacklog } from './sync';
import type { UpdateMappingInput, UpdateSheetSettingsInput } from './dto';

const log = createLogger('sheets-service');

/**
 * Google Sheets configuration.
 *
 * The screen this serves is a three-step sequence — connect an account, pick a
 * sheet, map the columns — and each step is only reachable once the one before
 * it is done. That order is enforced here rather than only in the UI, because
 * "pick a sheet" without an account and "map columns" without a sheet are both
 * requests the API has to answer sensibly regardless of what the client does.
 */

/** One call the settings screen makes on load, rather than three. */
export async function overview(shopId: string): Promise<SheetsOverview> {
  const [account, config, customFieldSources] = await Promise.all([
    googleService.getAccount(shopId),
    repository.findConfigByShop(shopId),
    repository.findCustomFieldSources(shopId),
  ]);

  return {
    account,
    config: config ? toSummary(config) : null,
    customFieldSources,
  };
}

/**
 * Spreadsheets the app can see.
 *
 * Under the `drive.file` scope this is only files CODkar created plus any the
 * merchant explicitly shared — never their whole Drive. The admin says so,
 * because a merchant who owns forty spreadsheets and sees two will otherwise
 * assume the integration is broken.
 */
export async function listAvailableSpreadsheets(shopId: string): Promise<SpreadsheetSummary[]> {
  const { accessToken } = await googleService.accessTokenFor(shopId);
  const files = await listSpreadsheets(accessToken);

  return files.map((file) => ({
    id: file.id,
    name: file.name,
    url: file.webViewLink ?? `https://docs.google.com/spreadsheets/d/${file.id}`,
    modifiedAt: file.modifiedTime ?? null,
  }));
}

export async function listWorksheets(
  shopId: string,
  spreadsheetId: string,
): Promise<WorksheetSummary[]> {
  const { accessToken } = await googleService.accessTokenFor(shopId);
  const meta = await getSpreadsheet(accessToken, spreadsheetId);

  return meta.sheets.map((sheet) => ({
    gid: sheet.properties.sheetId,
    title: sheet.properties.title,
    index: sheet.properties.index,
  }));
}

/**
 * Creates a spreadsheet in the merchant's Drive and targets it.
 *
 * The path most merchants take: they do not have a sheet ready, and asking them
 * to make one in another tab and come back is where setup flows lose people.
 * A file created by the app is also automatically within `drive.file` scope,
 * so no further sharing step is needed.
 */
export async function createAndSelect(
  shopId: string,
  title: string,
  worksheetName: string,
): Promise<SheetConfigSummary> {
  const { accessToken, accountId } = await googleService.accessTokenFor(shopId);

  const created = await createSpreadsheet(accessToken, title, worksheetName);
  const worksheet = created.sheets[0]?.properties;

  const config = await repository.upsertConfig({
    shopId,
    googleAccountId: accountId,
    spreadsheetId: created.spreadsheetId,
    spreadsheetName: created.properties.title,
    spreadsheetUrl: created.spreadsheetUrl,
    worksheetName: worksheet?.title ?? worksheetName,
    worksheetGid: worksheet?.sheetId ?? null,
  });

  // A brand-new sheet with no mapping would leave the merchant on an empty
  // grid. Seeding the default mapping means step three arrives already filled
  // in and they only adjust it.
  const seeded = await ensureMapping(config, shopId);

  log.info({ shopId, spreadsheetId: created.spreadsheetId }, 'Spreadsheet created and selected');

  return toSummary(seeded);
}

/** Points the sync at an existing spreadsheet the merchant chose. */
export async function selectExisting(
  shopId: string,
  spreadsheetId: string,
  worksheetName: string | undefined,
): Promise<SheetConfigSummary> {
  const { accessToken, accountId } = await googleService.accessTokenFor(shopId);
  const meta = await getSpreadsheet(accessToken, spreadsheetId);

  let worksheet = worksheetName
    ? meta.sheets.find((sheet) => sheet.properties.title === worksheetName)
    : meta.sheets[0];

  // A named tab that does not exist yet is created rather than rejected — the
  // merchant asked for it by name, and making them go and add it manually is
  // busywork the app can do.
  if (!worksheet && worksheetName) {
    const gid = await addWorksheet(accessToken, spreadsheetId, worksheetName);
    worksheet = { properties: { sheetId: gid, title: worksheetName, index: meta.sheets.length } };
  }

  if (!worksheet) {
    throw new BadRequestError('That spreadsheet has no worksheets');
  }

  const config = await repository.upsertConfig({
    shopId,
    googleAccountId: accountId,
    spreadsheetId: meta.spreadsheetId,
    spreadsheetName: meta.properties.title,
    spreadsheetUrl: meta.spreadsheetUrl,
    worksheetName: worksheet.properties.title,
    worksheetGid: worksheet.properties.sheetId,
  });

  const seeded = await ensureMapping(config, shopId);

  log.info({ shopId, spreadsheetId }, 'Existing spreadsheet selected');

  return toSummary(seeded);
}

/** Seeds the default mapping when a config has none. */
async function ensureMapping(config: SheetConfig, shopId: string): Promise<SheetConfig> {
  const existing = Array.isArray(config.columnMapping) ? config.columnMapping : [];

  if (existing.length > 0) return config;

  log.debug({ shopId }, 'Seeding the default column mapping');

  return repository.updateConfig(config.id, {
    columnMapping: DEFAULT_COLUMN_MAPPING as unknown as object,
  });
}

/**
 * Saves the column mapping.
 *
 * Column letters are assigned here from array position, never taken from the
 * request. The sync writes cells by position, so a client that sent an order
 * and a set of letters that disagreed would produce a sheet whose headers did
 * not match its data — and nothing would surface the mismatch until a merchant
 * noticed phone numbers under "City".
 */
export async function updateMapping(
  shopId: string,
  input: UpdateMappingInput,
): Promise<SheetConfigSummary> {
  const config = await repository.findConfigByShop(shopId);
  if (!config) throw new NotFoundError('Select a Google Sheet first');

  const customKeys = new Set(
    (await repository.findCustomFieldSources(shopId)).map((field) => field.key),
  );

  const mapping: SheetColumnMapping[] = input.columns.map((column, index) => {
    if (isCustomFieldSource(column.source)) {
      const key = column.source.split('.')[1] ?? '';

      if (!customKeys.has(key)) {
        throw new ValidationError('That custom field no longer exists on any of your forms', {
          details: { [`columns.${index}.source`]: [`Unknown custom field "${key}"`] },
        });
      }
    } else if (!sheetFieldSource(column.source)) {
      throw new ValidationError('Unknown field', {
        details: { [`columns.${index}.source`]: [`"${column.source}" is not a field CODkar can export`] },
      });
    }

    return {
      column: columnLetter(index),
      header: column.header,
      source: column.source,
    };
  });

  const updated = await repository.updateConfig(config.id, {
    columnMapping: mapping as unknown as object,
  });

  log.info({ shopId, columns: mapping.length }, 'Column mapping updated');

  return toSummary(updated);
}

export async function updateSettings(
  shopId: string,
  input: UpdateSheetSettingsInput,
): Promise<SheetConfigSummary> {
  const config = await repository.findConfigByShop(shopId);
  if (!config) throw new NotFoundError('Select a Google Sheet first');

  const updated = await repository.updateConfig(config.id, {
    ...input,
    // Reactivating is how a merchant recovers after fixing a deleted or
    // un-shared spreadsheet, so the stale error goes with it.
    ...(input.isActive === true ? { lastError: null } : {}),
  });

  return toSummary(updated);
}

/**
 * Queues historic orders that are not yet in the sheet.
 *
 * Enqueued rather than written inline — Google's per-minute write quota means a
 * synchronous backfill would either hold a request open for minutes or hit the
 * limit and fail most of the batch.
 */
export async function backfill(
  shopId: string,
  shopDomain: string,
  limit: number,
): Promise<{ queued: number }> {
  const config = await repository.findConfigByShop(shopId);
  if (!config) throw new NotFoundError('Select a Google Sheet first');

  const orders = await collectBacklog(shopId, limit);
  const queued = await enqueueSheetSyncBulk(
    shopDomain,
    orders.map((order) => order.id),
  );

  log.info({ shopId, queued }, 'Sheet backfill queued');

  return { queued };
}

function toSummary(config: SheetConfig): SheetConfigSummary {
  const mapping = Array.isArray(config.columnMapping)
    ? (config.columnMapping as unknown as SheetColumnMapping[])
    : [];

  return {
    id: config.id,
    spreadsheetId: config.spreadsheetId,
    spreadsheetName: config.spreadsheetName,
    spreadsheetUrl: config.spreadsheetUrl,
    worksheetName: config.worksheetName,
    worksheetGid: config.worksheetGid,
    isActive: config.isActive,
    autoSync: config.autoSync,
    includeHeaders: config.includeHeaders,
    layout: {
      singleRowPerOrder: config.singleRowPerOrder,
      insertAtTop: config.insertAtTop,
    },
    columnMapping: mapping,
    lastSyncedAt: config.lastSyncedAt?.toISOString() ?? null,
    lastSyncStatus: config.lastSyncStatus,
    lastError: config.lastError,
    totalSynced: config.totalSynced,
    totalFailed: config.totalFailed,
  };
}

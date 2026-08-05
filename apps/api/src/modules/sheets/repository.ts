import {
  Prisma,
  SyncStatus,
  SyncTrigger,
  type CodOrder,
  type SheetConfig,
} from '@prisma/client';
import { prisma } from '../../db/prisma';

/** Sheet configuration and sync-log persistence. */

export function findConfigByShop(shopId: string): Promise<SheetConfig | null> {
  return prisma.sheetConfig.findFirst({
    where: { shopId },
    orderBy: { createdAt: 'asc' },
  });
}

export function findConfigById(shopId: string, id: string): Promise<SheetConfig | null> {
  return prisma.sheetConfig.findFirst({ where: { id, shopId } });
}

export function findActiveConfig(shopId: string): Promise<SheetConfig | null> {
  return prisma.sheetConfig.findFirst({ where: { shopId, isActive: true, autoSync: true } });
}

export interface UpsertConfigInput {
  shopId: string;
  googleAccountId: string;
  spreadsheetId: string;
  spreadsheetName: string | null;
  spreadsheetUrl: string | null;
  worksheetName: string;
  worksheetGid: number | null;
}

/**
 * Creates or moves the shop's sheet target.
 *
 * A shop has one sheet configuration in practice, so changing the target
 * updates the existing row rather than accumulating. Counters and the header
 * flag reset with it — pointing at a fresh spreadsheet means the header has not
 * been written there yet, and carrying `totalSynced` across would misreport how
 * much is actually in the new sheet.
 */
export async function upsertConfig(input: UpsertConfigInput): Promise<SheetConfig> {
  const existing = await findConfigByShop(input.shopId);

  if (existing) {
    return prisma.sheetConfig.update({
      where: { id: existing.id },
      data: {
        googleAccountId: input.googleAccountId,
        spreadsheetId: input.spreadsheetId,
        spreadsheetName: input.spreadsheetName,
        spreadsheetUrl: input.spreadsheetUrl,
        worksheetName: input.worksheetName,
        worksheetGid: input.worksheetGid,
        isActive: true,
        lastError: null,
        ...(existing.spreadsheetId !== input.spreadsheetId ||
        existing.worksheetName !== input.worksheetName
          ? { totalSynced: 0, totalFailed: 0, nextRow: 2, lastSyncedAt: null, lastSyncStatus: null }
          : {}),
      },
    });
  }

  return prisma.sheetConfig.create({
    data: {
      shopId: input.shopId,
      googleAccountId: input.googleAccountId,
      spreadsheetId: input.spreadsheetId,
      spreadsheetName: input.spreadsheetName,
      spreadsheetUrl: input.spreadsheetUrl,
      worksheetName: input.worksheetName,
      worksheetGid: input.worksheetGid,
    },
  });
}

export function updateConfig(
  id: string,
  data: Prisma.SheetConfigUpdateInput,
): Promise<SheetConfig> {
  return prisma.sheetConfig.update({ where: { id }, data });
}

/** Records a successful write and bumps the counters in one statement. */
export function recordSuccess(id: string, rowsWritten: number): Promise<SheetConfig> {
  return prisma.sheetConfig.update({
    where: { id },
    data: {
      lastSyncedAt: new Date(),
      lastSyncStatus: SyncStatus.SUCCESS,
      lastError: null,
      totalSynced: { increment: 1 },
      nextRow: { increment: rowsWritten },
    },
  });
}

export function recordFailure(id: string, message: string): Promise<SheetConfig> {
  return prisma.sheetConfig.update({
    where: { id },
    data: {
      lastSyncStatus: SyncStatus.FAILED,
      lastError: message.slice(0, 1_000),
      totalFailed: { increment: 1 },
    },
  });
}

export interface SyncLogInput {
  shopId: string;
  sheetConfigId: string | null;
  codOrderId: string | null;
  status: SyncStatus;
  trigger: SyncTrigger;
  rowNumber?: number | null;
  payload?: Prisma.InputJsonValue;
  errorMessage?: string | null;
  errorCode?: string | null;
  attempt?: number;
  durationMs?: number | null;
  jobId?: string | null;
}

/**
 * Appends a sync log entry.
 *
 * The written values are retained in `payload`, which is what makes a failed
 * sync replayable and lets a merchant see exactly what went into a row they are
 * questioning.
 */
export function logSync(input: SyncLogInput): Promise<{ id: string }> {
  return prisma.sheetSyncLog.create({
    data: {
      shopId: input.shopId,
      sheetConfigId: input.sheetConfigId,
      codOrderId: input.codOrderId,
      status: input.status,
      trigger: input.trigger,
      rowNumber: input.rowNumber ?? null,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      errorMessage: input.errorMessage?.slice(0, 1_000) ?? null,
      errorCode: input.errorCode ?? null,
      attempt: input.attempt ?? 1,
      durationMs: input.durationMs ?? null,
      jobId: input.jobId ?? null,
    },
    select: { id: true },
  });
}

/**
 * Marks an order's sync state on the order itself.
 *
 * Denormalized from the log so the order list can filter on "not yet in my
 * sheet" without joining against a table that grows by one row per attempt.
 */
export function setOrderSyncStatus(
  codOrderId: string,
  status: SyncStatus,
  syncedAt: Date | null,
): Promise<{ id: string }> {
  return prisma.codOrder.update({
    where: { id: codOrderId },
    data: { sheetSyncStatus: status, sheetSyncedAt: syncedAt },
    select: { id: true },
  });
}

export function findOrder(codOrderId: string): Promise<CodOrder | null> {
  return prisma.codOrder.findUnique({ where: { id: codOrderId } });
}

/**
 * Orders that belong in the sheet but are not in it.
 *
 * Powers both the "sync existing orders" backfill and the retry list. Ordered
 * oldest-first so a backfill writes them into the sheet in the order they were
 * placed rather than newest-first.
 */
export function findUnsynced(shopId: string, limit: number): Promise<CodOrder[]> {
  return prisma.codOrder.findMany({
    where: {
      shopId,
      sheetSyncStatus: { in: [SyncStatus.PENDING, SyncStatus.FAILED, SyncStatus.RETRYING] },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

/** Shop context the sync needs: timezone for timestamps, domain for logging. */
export function findShopContext(shopId: string) {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: { domain: true, ianaTimezone: true, timezone: true, currencyCode: true },
  });
}

/**
 * Distinct custom field keys across the shop's forms.
 *
 * Populates the "Custom fields" group in the column-mapping dropdown. Read from
 * the form definitions rather than from order payloads, so a merchant can map a
 * field before any order has used it.
 */
export async function findCustomFieldSources(
  shopId: string,
): Promise<{ key: string; label: string }[]> {
  const fields = await prisma.formField.findMany({
    where: {
      formConfig: { shopId },
      isSystem: false,
      type: { notIn: ['HEADING', 'PARAGRAPH', 'DIVIDER'] },
    },
    select: { key: true, label: true },
    distinct: ['key'],
    orderBy: { key: 'asc' },
  });

  return fields.map((field) => ({ key: field.key, label: field.label }));
}

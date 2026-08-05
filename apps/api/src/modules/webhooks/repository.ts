import { SyncStatus, type Prisma } from '@prisma/client';
import { prisma, isUniqueConstraintError } from '../../db/prisma';

/**
 * Webhook receipt persistence.
 *
 * `WebhookEvent.shopifyWebhookId` carries a unique constraint, which is what
 * turns Shopify's at-least-once delivery into effectively-once processing. The
 * database, not application logic, is the arbiter: two concurrent deliveries of
 * the same webhook both attempt the insert, exactly one succeeds, and the other
 * gets a constraint violation it can safely treat as "already handled".
 *
 * The full payload is stored rather than discarded. That costs disk, and buys
 * the ability to replay: a topic whose processor ships in a later phase still
 * has its events waiting, and a handler that failed can be re-run against the
 * exact bytes that caused it.
 */

export interface ReceiptInput {
  shopifyWebhookId: string;
  topic: string;
  shopDomain: string;
  apiVersion: string | null;
  triggeredAt: Date | null;
  payload: Prisma.InputJsonValue;
  shopId: string | null;
}

export interface ReceiptResult {
  id: string;
  /** True when this delivery was seen before and must not be processed again. */
  duplicate: boolean;
}

export async function recordReceipt(input: ReceiptInput): Promise<ReceiptResult> {
  try {
    const event = await prisma.webhookEvent.create({
      data: {
        shopifyWebhookId: input.shopifyWebhookId,
        topic: input.topic,
        shopDomain: input.shopDomain,
        apiVersion: input.apiVersion,
        triggeredAt: input.triggeredAt,
        payload: input.payload,
        shopId: input.shopId,
        status: SyncStatus.PENDING,
      },
      select: { id: true },
    });

    return { id: event.id, duplicate: false };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const existing = await prisma.webhookEvent.findUnique({
      where: { shopifyWebhookId: input.shopifyWebhookId },
      select: { id: true },
    });

    // The row must exist — the constraint just fired on it — but a concurrent
    // shop/redact cascade could have removed it between the two statements.
    return { id: existing?.id ?? '', duplicate: true };
  }
}

export function markInProgress(id: string): Promise<{ id: string }> {
  return prisma.webhookEvent.update({
    where: { id },
    data: { status: SyncStatus.IN_PROGRESS, attempt: { increment: 1 } },
    select: { id: true },
  });
}

export function markProcessed(id: string): Promise<{ id: string }> {
  return prisma.webhookEvent.update({
    where: { id },
    data: { status: SyncStatus.SUCCESS, processedAt: new Date(), errorMessage: null },
    select: { id: true },
  });
}

export function markFailed(id: string, errorMessage: string): Promise<{ id: string }> {
  return prisma.webhookEvent.update({
    where: { id },
    data: {
      status: SyncStatus.FAILED,
      processedAt: new Date(),
      // Postgres text is unbounded, but a stack-trace-sized message in a column
      // that is read in list views is not worth the row width.
      errorMessage: errorMessage.slice(0, 1_000),
    },
    select: { id: true },
  });
}

/**
 * Records that no processor is registered for this topic yet.
 *
 * Distinct from a failure: the delivery was accepted and stored, and the app is
 * simply not doing anything with it in this build. Kept as SKIPPED so a
 * pending-work query does not mistake it for a stuck job, while remaining easy
 * to find when the processor lands.
 */
export function markUnhandled(id: string): Promise<{ id: string }> {
  return prisma.webhookEvent.update({
    where: { id },
    data: { status: SyncStatus.SKIPPED, processedAt: new Date() },
    select: { id: true },
  });
}

/** Deliveries that still need work, oldest first. Used by replay tooling. */
export function findPending(topic: string, limit: number) {
  return prisma.webhookEvent.findMany({
    where: { topic, status: { in: [SyncStatus.PENDING, SyncStatus.SKIPPED, SyncStatus.FAILED] } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

/**
 * Drops processed receipts older than the retention window.
 *
 * Webhook volume is the highest write rate in the app; without this the table
 * outgrows every other one within months. Only terminal rows are removed, so
 * anything still awaiting a processor survives regardless of age.
 */
export async function pruneProcessedBefore(cutoff: Date): Promise<number> {
  const result = await prisma.webhookEvent.deleteMany({
    where: { status: SyncStatus.SUCCESS, processedAt: { lt: cutoff } },
  });
  return result.count;
}

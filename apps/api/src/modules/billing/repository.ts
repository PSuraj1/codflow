import { Plan, Prisma, SubscriptionStatus, type Subscription } from '@prisma/client';
import { prisma } from '../../db/prisma';

/**
 * Billing persistence.
 *
 * `Subscription` here is a **cache of Shopify's answer**, not a record of a
 * charge. Nothing in this app creates, prices or bills a subscription — managed
 * pricing does all of that — so every write in this file is either a
 * reconciliation from Shopify or a local status change that Shopify has already
 * told us about.
 *
 * `UsageRecord` is the opposite: entirely ours. Shopify has no idea how many
 * COD orders a shop has taken this month, and the caps are the app's own
 * product decision.
 */

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

export function findByShop(shopId: string): Promise<Subscription | null> {
  return prisma.subscription.findUnique({ where: { shopId } });
}

/**
 * A shop's domain, for the plan-exemption check.
 *
 * Separate from the subscription read because an exempt shop may have no
 * subscription row at all — a shop that never subscribed still needs to be
 * recognised as exempt, and `findByShop` returns null for it.
 */
export async function findShopDomain(shopId: string): Promise<string | null> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { domain: true } });
  return shop?.domain ?? null;
}

export interface ReconcileInput {
  plan: Plan;
  status: SubscriptionStatus;
  planHandle: string | null;
  shopifySubscriptionGid: string | null;
  price: Prisma.Decimal | null;
  currencyCode: string;
  interval: string;
  trialDays: number;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  isTest: boolean;
  activatedAt: Date | null;
  cancelledAt: Date | null;
}

/**
 * Writes Shopify's answer over the local cache.
 *
 * A full overwrite rather than a merge. A partial update is how a cancelled
 * subscription keeps its old `currentPeriodEnd` and a downgraded shop keeps a
 * `trialEndsAt` from a plan it no longer has — fields that then read as
 * authoritative because nothing marks them stale.
 *
 * `lastVerifiedAt` is stamped here and nowhere else: it means "Shopify
 * confirmed this", and setting it from any other path would make an unverified
 * assumption indistinguishable from a verified fact.
 */
export async function reconcile(shopId: string, input: ReconcileInput): Promise<Subscription> {
  const verifiedAt = new Date();

  return prisma.subscription.upsert({
    where: { shopId },
    create: { shopId, ...input, lastVerifiedAt: verifiedAt },
    update: { ...input, lastVerifiedAt: verifiedAt },
  });
}

/**
 * Records that a shop has no active subscription.
 *
 * Distinct from "never checked": the shop drops to FREE and the verification
 * stamp is still written, because Shopify answering "nothing active" *is* an
 * answer. Treating it as a failed check would leave a cancelled shop on their
 * old plan until the next successful call.
 */
export async function reconcileToFree(shopId: string): Promise<Subscription> {
  return reconcile(shopId, {
    plan: Plan.FREE,
    status: SubscriptionStatus.ACTIVE,
    planHandle: null,
    shopifySubscriptionGid: null,
    price: null,
    currencyCode: 'USD',
    interval: 'EVERY_30_DAYS',
    trialDays: 0,
    trialEndsAt: null,
    currentPeriodEnd: null,
    isTest: false,
    activatedAt: null,
    cancelledAt: null,
  });
}

/** Shops whose cached plan is older than a cutoff, for background refresh. */
export function findStale(cutoff: Date, limit: number): Promise<Array<{ shopId: string }>> {
  return prisma.subscription.findMany({
    where: {
      OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: cutoff } }],
      // A shop that has uninstalled has no session to query with.
      shop: { uninstalledAt: null },
    },
    select: { shopId: true },
    take: limit,
    orderBy: { lastVerifiedAt: { sort: 'asc', nulls: 'first' } },
  });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * The first instant of the billing month a date falls in, in UTC.
 *
 * UTC rather than the shop's timezone, deliberately — and this is the one place
 * in the app where that is the right choice. A cap is a commercial boundary
 * shared with Shopify's own billing cycle, not a thing that happened on a day
 * the merchant experienced. Cutting it per-shop would give two merchants
 * different month lengths for the same price, and make the unique key on
 * `UsageRecord` depend on a mutable shop setting.
 */
export function periodStart(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The exclusive end of the same month. */
export function periodEnd(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/**
 * Adds to a metric's counter for the current period.
 *
 * One atomic statement. A read-then-write would lose increments under any real
 * order volume, and undercounting is the failure that matters: it lets a shop
 * past a cap they have actually reached, which the merchant only discovers when
 * an invoice or an enforcement decision disagrees with what they were shown.
 *
 * `limitAtTime` is stamped on creation and never updated, so a record made in
 * March still says what the cap was in March even after the plan changes.
 */
export async function recordUsage(
  shopId: string,
  metric: string,
  quantity: number,
  limitAtTime: number | null,
  at: Date = new Date(),
): Promise<void> {
  if (quantity === 0) return;

  const start = periodStart(at);

  await prisma.usageRecord.upsert({
    where: { shopId_periodStart_metric: { shopId, periodStart: start, metric } },
    create: {
      shopId,
      periodStart: start,
      metric,
      quantity,
      ...(limitAtTime === null ? {} : { limitAtTime }),
    },
    update: { quantity: { increment: quantity } },
  });
}

/** Every metric's counter for one period, keyed by metric. */
export async function usageForPeriod(
  shopId: string,
  at: Date = new Date(),
): Promise<Record<string, number>> {
  const records = await prisma.usageRecord.findMany({
    where: { shopId, periodStart: periodStart(at) },
    select: { metric: true, quantity: true },
  });

  const usage: Record<string, number> = {};
  for (const record of records) usage[record.metric] = record.quantity;

  return usage;
}

/** One metric's counter. Read on the enforcement path, so kept narrow. */
export async function usageFor(
  shopId: string,
  metric: string,
  at: Date = new Date(),
): Promise<number> {
  const record = await prisma.usageRecord.findUnique({
    where: { shopId_periodStart_metric: { shopId, periodStart: periodStart(at), metric } },
    select: { quantity: true },
  });

  return record?.quantity ?? 0;
}

// ---------------------------------------------------------------------------
// Entity counts — the other kind of limit
// ---------------------------------------------------------------------------

/**
 * How many of a plan-limited *thing* a shop has.
 *
 * Distinct from usage: these are not consumed monthly, they simply exist. A
 * shop on Starter may create three forms and keep them forever; the limit is on
 * the count, not on a rate, so there is nothing to reset.
 */
export async function countPixels(shopId: string): Promise<number> {
  return prisma.pixel.count({ where: { shopId } });
}

export async function countSheetConfigs(shopId: string): Promise<number> {
  return prisma.sheetConfig.count({ where: { shopId } });
}

export async function countForms(shopId: string): Promise<number> {
  return prisma.formConfig.count({ where: { shopId } });
}

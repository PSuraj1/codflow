import {
  BlockListScope,
  BlockListType,
  CodOrderStatus,
  Prisma,
  type BlockListEntry,
  type FraudRule,
  type FraudSettings,
} from '@prisma/client';
import { prisma } from '../../db/prisma';

/**
 * Fraud persistence.
 *
 * Every counting query here runs on the order submission path, so each one is
 * written to hit an index that already exists in the schema — `[shopId,
 * phoneE164]`, `[ipAddress]`, `[addressHash]`, `[email]`. A sequential scan
 * over `cod_orders` on every checkout is the difference between a fraud engine
 * and an outage.
 */

export async function getSettings(shopId: string): Promise<FraudSettings> {
  // Created at provisioning, so this normally hits. The upsert covers shops
  // that predate the model, and keeps the engine from having to handle null.
  return prisma.fraudSettings.upsert({
    where: { shopId },
    update: {},
    create: { shopId },
  });
}

export function updateSettings(
  shopId: string,
  data: Prisma.FraudSettingsUpdateInput,
): Promise<FraudSettings> {
  return prisma.fraudSettings.update({ where: { shopId }, data });
}

// ---------------------------------------------------------------------------
// Block lists
// ---------------------------------------------------------------------------

export interface BlockListLookup {
  readonly scope: BlockListScope;
  readonly value: string;
}

/**
 * Matches a set of identifiers against the shop's lists in one query.
 *
 * One round trip rather than seven: an order carries a phone, an email, an IP,
 * an address, a postal code, a country and a device id, and checking them
 * individually would put seven queries in front of every submission.
 *
 * Expired entries are filtered in SQL so a lapsed temporary block stops
 * applying without anything having to sweep the table.
 */
export function findBlockListMatches(
  shopId: string,
  lookups: readonly BlockListLookup[],
  now: Date,
): Promise<BlockListEntry[]> {
  if (lookups.length === 0) return Promise.resolve([]);

  return prisma.blockListEntry.findMany({
    where: {
      shopId,
      isActive: true,
      OR: lookups.map((lookup) => ({ scope: lookup.scope, value: lookup.value })),
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  });
}

/** Records that an entry matched, for the merchant's "is this rule working" view. */
export async function recordBlockListHits(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  await prisma.blockListEntry.updateMany({
    where: { id: { in: [...ids] } },
    data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
  });
}

export function listBlockList(
  shopId: string,
  filter: { type?: BlockListType; scope?: BlockListScope; search?: string },
  limit: number,
): Promise<BlockListEntry[]> {
  return prisma.blockListEntry.findMany({
    where: {
      shopId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.scope ? { scope: filter.scope } : {}),
      ...(filter.search ? { value: { contains: filter.search, mode: 'insensitive' } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function upsertBlockListEntry(
  shopId: string,
  entry: {
    type: BlockListType;
    scope: BlockListScope;
    value: string;
    reason: string | null;
    createdBy: string;
    expiresAt: Date | null;
  },
): Promise<BlockListEntry> {
  return prisma.blockListEntry.upsert({
    where: {
      shopId_type_scope_value: {
        shopId,
        type: entry.type,
        scope: entry.scope,
        value: entry.value,
      },
    },
    // Re-adding an entry reactivates it and refreshes the reason rather than
    // failing — which is what a merchant expects when they add the same number
    // again after it lapsed.
    update: {
      reason: entry.reason,
      expiresAt: entry.expiresAt,
      isActive: true,
    },
    create: { shopId, ...entry },
  });
}

/** Every entry in one list, for reconciling a wholesale replacement. */
export function listScope(
  shopId: string,
  type: BlockListType,
  scope: BlockListScope,
): Promise<BlockListEntry[]> {
  return prisma.blockListEntry.findMany({ where: { shopId, type, scope } });
}

/**
 * Removes named values from one list.
 *
 * Scoped to the type and scope as well as the shop, so replacing the blocked
 * phone numbers cannot touch the allowed ones — the two are different lists
 * that happen to share a table.
 */
export async function deleteFromScope(
  shopId: string,
  type: BlockListType,
  scope: BlockListScope,
  values: readonly string[],
): Promise<number> {
  if (values.length === 0) return 0;

  const result = await prisma.blockListEntry.deleteMany({
    where: { shopId, type, scope, value: { in: [...values] } },
  });

  return result.count;
}

export async function deleteBlockListEntry(shopId: string, id: string): Promise<boolean> {
  const result = await prisma.blockListEntry.deleteMany({ where: { id, shopId } });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/** Statuses that count toward duplicate and velocity limits. */
const COUNTED: CodOrderStatus[] = [
  CodOrderStatus.CONFIRMED,
  CodOrderStatus.PUSHED_TO_SHOPIFY,
  CodOrderStatus.PENDING_OTP,
  CodOrderStatus.FULFILLED,
];

export interface CountWindow {
  readonly shopId: string;
  readonly since: Date;
  /** Excluded from its own count during a rescan. */
  readonly excludeOrderId: string | null;
}

function baseWhere(window: CountWindow): Prisma.CodOrderWhereInput {
  return {
    shopId: window.shopId,
    createdAt: { gte: window.since },
    status: { in: COUNTED },
    ...(window.excludeOrderId ? { id: { not: window.excludeOrderId } } : {}),
  };
}

export function countByPhone(window: CountWindow, phoneE164: string): Promise<number> {
  return prisma.codOrder.count({ where: { ...baseWhere(window), phoneE164 } });
}

export function countByEmail(window: CountWindow, email: string): Promise<number> {
  return prisma.codOrder.count({ where: { ...baseWhere(window), email } });
}

export function countByIp(window: CountWindow, ipAddress: string): Promise<number> {
  return prisma.codOrder.count({ where: { ...baseWhere(window), ipAddress } });
}

/**
 * Orders from one device.
 *
 * Only meaningful when the storefront produced a fingerprint — it is absent for
 * shoppers blocking the script, so a null must never be counted as "the same
 * device as every other null".
 */
export function countByDevice(window: CountWindow, deviceFingerprint: string): Promise<number> {
  return prisma.codOrder.count({ where: { ...baseWhere(window), deviceFingerprint } });
}

export function countByAddress(window: CountWindow, addressHash: string): Promise<number> {
  return prisma.codOrder.count({ where: { ...baseWhere(window), addressHash } });
}

/**
 * COD orders already out for delivery for this customer.
 *
 * The signal a merchant actually cares about: someone with three parcels
 * unpaid and undelivered ordering a fourth. Not time-windowed, because an old
 * unresolved order is *more* concerning than a recent one.
 */
export function countOpenOrders(
  shopId: string,
  phoneE164: string,
  excludeOrderId: string | null,
): Promise<number> {
  return prisma.codOrder.count({
    where: {
      shopId,
      phoneE164,
      status: { in: [CodOrderStatus.CONFIRMED, CodOrderStatus.PUSHED_TO_SHOPIFY] },
      ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
    },
  });
}

/**
 * Historic cancellations and returns for a phone number.
 *
 * The strongest predictor available for COD specifically: a customer who has
 * refused delivery before is far more likely to do it again, and it is the
 * merchant's own data rather than a third party's guess.
 */
export async function countPriorFailures(
  shopId: string,
  phoneE164: string,
  excludeOrderId: string | null,
): Promise<{ cancelled: number; returned: number }> {
  const where = {
    shopId,
    phoneE164,
    ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
  };

  const [cancelled, returned] = await Promise.all([
    prisma.codOrder.count({ where: { ...where, status: CodOrderStatus.CANCELLED } }),
    prisma.codOrder.count({
      where: { ...where, status: { in: [CodOrderStatus.RETURNED, CodOrderStatus.REFUNDED] } },
    }),
  ]);

  return { cancelled, returned };
}

// ---------------------------------------------------------------------------
// Merchant rules
// ---------------------------------------------------------------------------

export function listEnabledRules(shopId: string): Promise<FraudRule[]> {
  return prisma.fraudRule.findMany({
    where: { shopId, isEnabled: true },
    // Lower priority first; ties broken by age so the ordering is stable.
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
}

export function listAllRules(shopId: string): Promise<FraudRule[]> {
  return prisma.fraudRule.findMany({
    where: { shopId },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function recordRuleMatches(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;

  await prisma.fraudRule.updateMany({
    where: { id: { in: [...ids] } },
    data: { matchCount: { increment: 1 }, lastMatchedAt: new Date() },
  });
}

export function createRule(
  shopId: string,
  data: Omit<Prisma.FraudRuleCreateInput, 'shop'>,
): Promise<FraudRule> {
  return prisma.fraudRule.create({ data: { ...data, shop: { connect: { id: shopId } } } });
}

export function updateRule(
  shopId: string,
  id: string,
  data: Prisma.FraudRuleUpdateInput,
): Promise<Prisma.BatchPayload> {
  return prisma.fraudRule.updateMany({ where: { id, shopId }, data });
}

export async function deleteRule(shopId: string, id: string): Promise<boolean> {
  const result = await prisma.fraudRule.deleteMany({ where: { id, shopId } });
  return result.count > 0;
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export function createAssessment(data: Prisma.RiskAssessmentUncheckedCreateInput) {
  return prisma.riskAssessment.create({ data });
}

export function findLatestAssessment(shopId: string, codOrderId: string) {
  return prisma.riskAssessment.findFirst({
    where: { shopId, codOrderId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Records a merchant's override of an automated decision.
 *
 * Written onto the assessment rather than replacing it: the original score and
 * its signals stay intact, so the record of *why* the engine decided what it
 * did survives the merchant disagreeing with it.
 */
export function recordReview(
  id: string,
  decision: Prisma.RiskAssessmentUpdateInput,
): Promise<{ id: string }> {
  return prisma.riskAssessment.update({
    where: { id },
    data: decision,
    select: { id: true },
  });
}

/** Denormalizes the verdict onto the order, for fast filtering and the gates. */
export function applyVerdictToOrder(
  codOrderId: string,
  score: number,
  level: Prisma.CodOrderUpdateInput['riskLevel'],
  action: Prisma.CodOrderUpdateInput['riskAction'],
): Promise<{ id: string }> {
  return prisma.codOrder.update({
    where: { id: codOrderId },
    data: { riskScore: score, riskLevel: level, riskAction: action },
    select: { id: true },
  });
}

import {
  BlockListScope,
  BlockListType,
  Prisma,
  RiskAction,
  RiskLevel,
  type CodOrder,
  type FraudSettings,
} from '@prisma/client';
import {
  FRAUD_ENGINE_VERSION,
  type BlockListEntrySummary,
  type FraudRuleSummary,
  type FraudSettingsSummary,
  type RiskAssessmentSummary,
  type RiskSignalResult,
} from '@codflow/shared';
import { config } from '../../config/env';
import { createLogger } from '../../lib/logger';
import { NotFoundError, toError } from '../../lib/errors';
import { normalizePhone } from '../../lib/phone';
import { enqueueFraudScanBulk } from '../../queue/queues';
import * as orderRepository from '../orders/repository';
import { assess, type Assessment } from './engine';
import * as repository from './repository';
import type { FraudSubject } from './types';

const log = createLogger('fraud-service');

/**
 * Combined quantity across stored line items.
 *
 * The column is JSON, so this cannot assume a shape — an order written before
 * the field existed, or by an older version, still has to score rather than
 * throw. An unreadable list counts as zero, which leaves the quantity check
 * silent rather than firing on bad data.
 */
function sumQuantity(lineItems: unknown): number {
  if (!Array.isArray(lineItems)) return 0;

  return lineItems.reduce<number>((total, item) => {
    const quantity = (item as { quantity?: unknown } | null)?.quantity;
    return total + (typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : 0);
  }, 0);
}

/**
 * Fraud orchestration.
 *
 * Sits between the order pipeline and the engine, and owns the two things the
 * engine deliberately does not: persisting the assessment, and reacting to the
 * verdict — which for COD includes auto-blacklisting a phone number after
 * enough failed deliveries.
 */

export interface AssessmentOutcome {
  readonly assessment: Assessment;
  /** Null when the assessment ran before the order row existed. */
  readonly assessmentId: string | null;
}

/**
 * Assesses a submission and records the result.
 *
 * Called twice in an order's life, with different arguments each time:
 *
 *  - at submission, with `codOrderId: null`, to decide whether an order should
 *    be created at all;
 *  - on a rescan, with the saved order, to re-evaluate after the merchant
 *    changed a rule or a blacklist entry.
 *
 * Persisting is best-effort. A failed insert is logged but never propagated —
 * the verdict is what the caller needs, and losing the audit row is a smaller
 * problem than failing a checkout over it.
 */
export async function assessAndRecord(subject: FraudSubject): Promise<AssessmentOutcome> {
  const assessment = await assess(subject);

  if (!subject.codOrderId) {
    return { assessment, assessmentId: null };
  }

  const assessmentId = await persistAssessment(subject.codOrderId, subject, assessment);
  return { assessment, assessmentId };
}

/**
 * Writes an assessment against an order.
 *
 * Separate from `assessAndRecord` because the submission path assesses *before*
 * the order exists — the verdict decides whether it should — and can only
 * attach the record once the row has an id. A rescan calls the combined form
 * instead, since its order is already there.
 */
export async function persistAssessment(
  codOrderId: string,
  subject: FraudSubject,
  assessment: Assessment,
): Promise<string | null> {
  try {
    const row = await repository.createAssessment({
      shopId: subject.shopId,
      codOrderId,
      score: assessment.score,
      level: assessment.level,
      action: assessment.action,
      signals: assessment.signals as unknown as Prisma.InputJsonValue,
      matchedRuleIds: [...assessment.matchedRuleIds],
      ipCountryCode: assessment.ipIntel.countryCode,
      ipIsVpn: assessment.ipIntel.isVpn,
      ipIsProxy: assessment.ipIntel.isProxy,
      ipIsTor: assessment.ipIntel.isTor,
      ipIsHosting: assessment.ipIntel.isHosting,
      ipReputationScore: assessment.ipIntel.reputationScore,
      emailIsDisposable: assessment.signals.some((entry) => entry.code === 'DISPOSABLE_EMAIL'),
      phoneIsValid: subject.phoneIsValid,
      phoneLineType: subject.phoneType,
      engineVersion: FRAUD_ENGINE_VERSION,
      durationMs: assessment.durationMs,
    });

    await repository.applyVerdictToOrder(
      codOrderId,
      assessment.score,
      assessment.level,
      assessment.action,
    );

    return row.id;
  } catch (error) {
    // Best-effort. The verdict has already been applied in memory and, on the
    // submission path, written onto the order at creation — losing the audit
    // row is a smaller problem than failing a checkout over it.
    log.error(
      { err: toError(error), codOrderId },
      'Could not persist the risk assessment — verdict still applied',
    );
    return null;
  }
}

/** Builds an engine subject from a saved order, for a rescan. */
export function subjectFromOrder(order: CodOrder, shopDomain: string): FraudSubject {
  const phone = normalizePhone(order.phone, order.countryCode);

  return {
    shopId: order.shopId,
    shopDomain,
    codOrderId: order.id,
    phone: order.phone,
    phoneE164: order.phoneE164 ?? phone.e164,
    email: order.email,
    addressHash: order.addressHash,
    postalCode: order.postalCode,
    countryCode: order.countryCode,
    province: order.province,
    city: order.city,
    ipAddress: order.ipAddress,
    userAgent: order.userAgent,
    deviceFingerprint: order.deviceFingerprint,
    total: Number(order.total),
    subtotal: Number(order.subtotal),
    itemCount: Array.isArray(order.lineItems) ? order.lineItems.length : 0,
    itemQuantity: sumQuantity(order.lineItems),
    currency: order.currency,
    utmSource: order.utmSource,
    utmCampaign: order.utmCampaign,
    phoneIsValid: phone.valid,
    phoneType: phone.type,
    // Carried onto the order at submission so a rescan months later honours the
    // choice the shopper actually made, rather than re-deciding without it.
    profilingOptOut: order.profilingOptOut,
  };
}

/**
 * Re-runs the engine against a saved order.
 *
 * The merchant-facing "rescan" action, and what the queue runs after a rule or
 * blacklist change. A rescan can only ever tighten or relax the verdict on an
 * order that has not shipped — the push gates read `riskAction` fresh, so an
 * order rescanned to BLOCK before its push job runs is stopped.
 */
export async function rescanOrder(order: CodOrder, shopDomain: string): Promise<AssessmentOutcome> {
  return assessAndRecord(subjectFromOrder(order, shopDomain));
}

/**
 * Queues a re-score of every order a change could still affect.
 *
 * Called whenever a merchant edits something the engine reads — a threshold, a
 * rule, a block list entry. Without it, adding a phone number to the block list
 * would only affect *future* orders, while the merchant's actual intent is
 * almost always to catch the ones already sitting in review.
 *
 * Bounded per call. A shop with ten thousand pending orders should not turn one
 * settings save into ten thousand queued jobs.
 */
export async function rescanPending(
  shopId: string,
  shopDomain: string,
  limit = 200,
): Promise<{ queued: number }> {
  const orders = await orderRepository.findRescannable(shopId, limit);
  const queued = await enqueueFraudScanBulk(
    shopDomain,
    orders.map((order) => order.id),
  );

  if (queued > 0) {
    log.info({ shopId, queued }, 'Queued a rescan of pending orders after a configuration change');
  }

  return { queued };
}

/**
 * Blacklists a phone number after repeated failed deliveries.
 *
 * The one place the app writes to a merchant's block list on its own, and it is
 * off by default (`autoBlacklistAfterFailures: 0`). Automatic blocking is a
 * decision with a real cost — a customer whose parcels were lost by a courier
 * looks identical to one who refuses them — so it is opt-in, and the entry
 * records that the system added it rather than the merchant.
 */
export async function maybeAutoBlacklist(
  shopId: string,
  phoneE164: string | null,
): Promise<boolean> {
  if (!phoneE164) return false;

  const settings = await repository.getSettings(shopId);
  if (settings.autoBlacklistAfterFailures <= 0) return false;

  const { cancelled, returned } = await repository.countPriorFailures(shopId, phoneE164, null);
  const failures = cancelled + returned;

  if (failures < settings.autoBlacklistAfterFailures) return false;

  await repository.upsertBlockListEntry(shopId, {
    type: BlockListType.BLACKLIST,
    scope: BlockListScope.PHONE,
    value: phoneE164,
    reason: `Added automatically after ${failures} cancelled or returned COD orders.`,
    createdBy: 'system',
    expiresAt: null,
  });

  log.warn({ shopId, failures }, 'Phone auto-blacklisted after repeated failed deliveries');
  return true;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(shopId: string): Promise<FraudSettingsSummary> {
  return toSettingsSummary(await repository.getSettings(shopId));
}

export async function updateSettings(
  shopId: string,
  input: Prisma.FraudSettingsUpdateInput,
): Promise<FraudSettingsSummary> {
  return toSettingsSummary(await repository.updateSettings(shopId, input));
}

function toSettingsSummary(settings: FraudSettings): FraudSettingsSummary {
  return {
    isEnabled: settings.isEnabled,
    mediumThreshold: settings.mediumThreshold,
    highThreshold: settings.highThreshold,
    criticalThreshold: settings.criticalThreshold,
    actionOnMedium: settings.actionOnMedium,
    actionOnHigh: settings.actionOnHigh,
    actionOnCritical: settings.actionOnCritical,
    checkDuplicatePhone: settings.checkDuplicatePhone,
    checkDuplicateEmail: settings.checkDuplicateEmail,
    checkDuplicateAddress: settings.checkDuplicateAddress,
    checkDisposableEmail: settings.checkDisposableEmail,
    checkFakePhone: settings.checkFakePhone,
    checkVpn: settings.checkVpn,
    checkProxy: settings.checkProxy,
    checkTor: settings.checkTor,
    checkVelocity: settings.checkVelocity,
    checkCountryRisk: settings.checkCountryRisk,
    checkIpReputation: settings.checkIpReputation,
    checkBlockList: settings.checkBlockList,
    maxOrdersPerDayPerPhone: settings.maxOrdersPerDayPerPhone,
    maxOrdersPerDayPerIp: settings.maxOrdersPerDayPerIp,
    maxOrdersPerDayPerEmail: settings.maxOrdersPerDayPerEmail,
    maxOpenCodOrders: settings.maxOpenCodOrders,
    velocityWindowMinutes: settings.velocityWindowMinutes,
    velocityMaxOrders: settings.velocityMaxOrders,
    duplicateWindowHours: settings.duplicateWindowHours,
    highRiskCountryCodes: settings.highRiskCountryCodes,
    maxItemsPerOrder: settings.maxItemsPerOrder,
    checkDeviceVelocity: settings.checkDeviceVelocity,
    maxOrdersPerDayPerDevice: settings.maxOrdersPerDayPerDevice,
    blockedMessage: settings.blockedMessage,

    autoBlacklistAfterFailures: settings.autoBlacklistAfterFailures,
    tagHighRiskOrders: settings.tagHighRiskOrders,
    highRiskTag: settings.highRiskTag,
    // Network detectors are only meaningful when a provider is configured on
    // the deployment, so the admin greys them out rather than offering toggles
    // that silently do nothing.
    ipIntelAvailable: config.ipIntel.isConfigured,
  };
}

// ---------------------------------------------------------------------------
// Block list
// ---------------------------------------------------------------------------

/**
 * Normalizes a value to the form the detectors look it up by.
 *
 * A merchant pasting `+91 98765 43210` and a detector querying
 * `+919876543210` would never match, and the entry would silently do nothing —
 * the worst failure mode for a security control, because it looks configured.
 */
export function normalizeBlockListValue(scope: BlockListScope, value: string): string {
  const trimmed = value.trim();

  switch (scope) {
    case BlockListScope.PHONE: {
      const parsed = normalizePhone(trimmed);
      return parsed.e164 ?? trimmed.replace(/[^\d+]/g, '');
    }
    case BlockListScope.EMAIL:
      return trimmed.toLowerCase();
    case BlockListScope.POSTAL_CODE:
    case BlockListScope.COUNTRY:
      return trimmed.toUpperCase();
    default:
      return trimmed;
  }
}

export async function listBlockList(
  shopId: string,
  filter: { type?: BlockListType; scope?: BlockListScope; search?: string },
  limit: number,
): Promise<BlockListEntrySummary[]> {
  const entries = await repository.listBlockList(shopId, filter, limit);

  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    scope: entry.scope,
    value: entry.value,
    reason: entry.reason,
    createdBy: entry.createdBy,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    isActive: entry.isActive,
    hitCount: entry.hitCount,
    lastHitAt: entry.lastHitAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
  }));
}

export async function addBlockListEntry(
  shopId: string,
  input: {
    type: BlockListType;
    scope: BlockListScope;
    value: string;
    reason?: string;
    expiresAt?: Date;
  },
): Promise<BlockListEntrySummary> {
  const entry = await repository.upsertBlockListEntry(shopId, {
    type: input.type,
    scope: input.scope,
    value: normalizeBlockListValue(input.scope, input.value),
    reason: input.reason ?? null,
    createdBy: 'merchant',
    expiresAt: input.expiresAt ?? null,
  });

  return {
    id: entry.id,
    type: entry.type,
    scope: entry.scope,
    value: entry.value,
    reason: entry.reason,
    createdBy: entry.createdBy,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    isActive: entry.isActive,
    hitCount: entry.hitCount,
    lastHitAt: entry.lastHitAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}

export interface BulkBlockListResult {
  readonly total: number;
  readonly added: number;
  readonly removed: number;
  /** Lines the merchant sent that normalized to something already in the list. */
  readonly duplicates: number;
}

/**
 * Replaces one list wholesale.
 *
 * Reconciled rather than deleted-and-recreated, so an entry that survives the
 * edit keeps its `hitCount` and `lastHitAt` — those are the merchant's evidence
 * that a rule is doing something, and wiping them on every save would make the
 * list look permanently untested.
 *
 * Values are normalized before comparison, which is what makes the edit
 * idempotent: a merchant who pastes `+91 98765 43210` over a stored
 * `+919876543210` has changed nothing, and should not see one entry removed and
 * an identical one added.
 */
export async function replaceBlockList(
  shopId: string,
  type: BlockListType,
  scope: BlockListScope,
  values: readonly string[],
): Promise<BulkBlockListResult> {
  const normalized = values
    .map((value) => normalizeBlockListValue(scope, value))
    .filter((value) => value.length > 0);

  const wanted = new Set(normalized);
  const duplicates = normalized.length - wanted.size;

  const existing = await repository.listScope(shopId, type, scope);
  const have = new Set(existing.map((entry) => entry.value));

  const toRemove = existing
    .filter((entry) => !wanted.has(entry.value))
    .map((entry) => entry.value);

  const toAdd = [...wanted].filter((value) => !have.has(value));

  const removed = await repository.deleteFromScope(shopId, type, scope, toRemove);

  for (const value of toAdd) {
    await repository.upsertBlockListEntry(shopId, {
      type,
      scope,
      value,
      reason: null,
      createdBy: 'merchant',
      expiresAt: null,
    });
  }

  log.info(
    { shopId, type, scope, added: toAdd.length, removed },
    'Block list replaced',
  );

  return { total: wanted.size, added: toAdd.length, removed, duplicates };
}

export async function removeBlockListEntry(shopId: string, id: string): Promise<void> {
  const removed = await repository.deleteBlockListEntry(shopId, id);
  if (!removed) throw new NotFoundError('Block list entry not found');
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function listRules(shopId: string): Promise<FraudRuleSummary[]> {
  const rules = await repository.listAllRules(shopId);

  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    isEnabled: rule.isEnabled,
    priority: rule.priority,
    conditions: rule.conditions,
    scoreDelta: rule.scoreDelta,
    action: rule.action,
    reason: rule.reason,
    matchCount: rule.matchCount,
    lastMatchedAt: rule.lastMatchedAt?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

export async function getLatestAssessment(
  shopId: string,
  codOrderId: string,
): Promise<RiskAssessmentSummary | null> {
  const row = await repository.findLatestAssessment(shopId, codOrderId);
  if (!row) return null;

  return {
    id: row.id,
    score: row.score,
    level: row.level,
    action: row.action,
    signals: (Array.isArray(row.signals) ? row.signals : []) as unknown as RiskSignalResult[],
    matchedRuleIds: row.matchedRuleIds,
    ipCountryCode: row.ipCountryCode,
    ipIsVpn: row.ipIsVpn,
    ipIsProxy: row.ipIsProxy,
    ipIsTor: row.ipIsTor,
    ipIsHosting: row.ipIsHosting,
    emailIsDisposable: row.emailIsDisposable,
    phoneIsValid: row.phoneIsValid,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewDecision: row.reviewDecision,
    reviewNote: row.reviewNote,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Records a merchant overriding the engine.
 *
 * Writes the decision onto both the assessment and the order: the assessment
 * keeps the original score and signals intact so the record of *why* the engine
 * decided what it did survives, while the order's `riskAction` is what the push
 * gates actually read.
 */
export async function reviewAssessment(
  shopId: string,
  codOrderId: string,
  decision: RiskAction,
  reviewedBy: string | null,
  note: string | null,
): Promise<void> {
  const assessment = await repository.findLatestAssessment(shopId, codOrderId);
  if (!assessment) throw new NotFoundError('No risk assessment for this order');

  await repository.recordReview(assessment.id, {
    reviewedAt: new Date(),
    reviewedBy,
    reviewDecision: decision,
    reviewNote: note,
  });

  await repository.applyVerdictToOrder(
    codOrderId,
    assessment.score,
    assessment.level as RiskLevel,
    decision,
  );

  log.info({ shopId, codOrderId, decision }, 'Merchant reviewed a risk assessment');
}

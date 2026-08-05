import { RiskAction, RiskLevel, type FraudSettings } from '@prisma/client';
import {
  FRAUD_ENGINE_VERSION,
  RISK_SCORE_MAX,
  RISK_SCORE_MIN,
  type RiskSignalResult,
} from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { lookupIp, IP_INTEL_UNKNOWN, type IpIntelResult } from '../../lib/ipIntel';
import { runDetectors } from './detectors';
import { evaluateRules, toRuleContext } from './rules';
import * as repository from './repository';
import type { FraudSubject } from './types';

const log = createLogger('fraud-engine');

/**
 * Risk scoring.
 *
 * Turns a set of independent signals into one number, one level and one
 * action. The engine owns that translation entirely — detectors report what
 * they observed, and only this file decides what it means — so a merchant's
 * threshold settings are the single place the outcome can be tuned.
 *
 * The whole thing is bounded by a deadline. It runs on a shopper's submission,
 * and an assessment that takes four seconds has already cost more than the
 * fraud it might prevent.
 */

/**
 * How long the engine may take before it gives up and lets the order through.
 *
 * Every detector is a handful of indexed counts, so the realistic cost is tens
 * of milliseconds; this exists for the pathological case — a database under
 * load, a lock, a provider hanging past its own timeout. Exceeding it produces
 * an allow with a recorded reason, never a block.
 */
const ASSESSMENT_DEADLINE_MS = 4_000;

export interface Assessment {
  readonly score: number;
  readonly level: RiskLevel;
  readonly action: RiskAction;
  readonly signals: readonly RiskSignalResult[];
  readonly matchedRuleIds: readonly string[];
  readonly ipIntel: IpIntelResult;
  readonly durationMs: number;
  /** Set when the engine could not complete and defaulted to allowing. */
  readonly degraded: boolean;
}

/** An allow produced without a real assessment. */
function permissive(reason: string, durationMs: number): Assessment {
  return {
    score: 0,
    level: RiskLevel.LOW,
    action: RiskAction.ALLOW,
    signals: [
      {
        code: 'ENGINE_SKIPPED',
        label: reason,
        weight: 0,
        matched: true,
      },
    ],
    matchedRuleIds: [],
    ipIntel: IP_INTEL_UNKNOWN,
    durationMs,
    degraded: true,
  };
}

/**
 * Maps a score to a level using the merchant's thresholds.
 *
 * Read defensively: a merchant can save thresholds out of order through the
 * API, and comparing high-to-low means a nonsensical configuration still
 * produces a defined answer rather than falling through to LOW.
 */
function toLevel(score: number, settings: FraudSettings): RiskLevel {
  if (score >= settings.criticalThreshold) return RiskLevel.CRITICAL;
  if (score >= settings.highThreshold) return RiskLevel.HIGH;
  if (score >= settings.mediumThreshold) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

function toAction(level: RiskLevel, settings: FraudSettings): RiskAction {
  switch (level) {
    case RiskLevel.CRITICAL:
      return settings.actionOnCritical;
    case RiskLevel.HIGH:
      return settings.actionOnHigh;
    case RiskLevel.MEDIUM:
      return settings.actionOnMedium;
    default:
      return RiskAction.ALLOW;
  }
}

/** Rejects an action string that is not one the schema knows. */
function parseAction(value: string | null): RiskAction | null {
  if (!value) return null;
  return (Object.values(RiskAction) as string[]).includes(value) ? (value as RiskAction) : null;
}

/**
 * Assesses one subject.
 *
 * Never throws. Every failure path — a dead database, a hung provider, a
 * malformed rule — resolves to an allow with the reason recorded on the
 * assessment. That asymmetry is deliberate and is the most important decision
 * in this module: a fraud engine that fails closed converts its own outage into
 * a total checkout outage, and for a COD merchant that is a far larger loss
 * than the fraud it was built to catch.
 */
export async function assess(subject: FraudSubject): Promise<Assessment> {
  const startedAt = Date.now();

  let settings: FraudSettings;

  try {
    settings = await repository.getSettings(subject.shopId);
  } catch (error) {
    log.error({ err: error, shopId: subject.shopId }, 'Could not load fraud settings');
    return permissive('Fraud settings unavailable — order allowed', Date.now() - startedAt);
  }

  if (!settings.isEnabled) {
    return permissive('Fraud protection is switched off', Date.now() - startedAt);
  }

  try {
    return await withDeadline(
      () => runAssessment(subject, settings, startedAt),
      ASSESSMENT_DEADLINE_MS,
    );
  } catch (error) {
    log.error(
      { err: error, shopId: subject.shopId, durationMs: Date.now() - startedAt },
      'Fraud assessment failed or timed out — allowing the order',
    );
    return permissive('Risk check could not complete — order allowed', Date.now() - startedAt);
  }
}

/** Races a task against a deadline, rejecting if it loses. */
async function withDeadline<T>(task: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Assessment exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    // Without this the timer keeps the event loop alive for the full deadline
    // on every fast assessment, which under load is thousands of live handles.
    if (timer) clearTimeout(timer);
  }
}

async function runAssessment(
  subject: FraudSubject,
  settings: FraudSettings,
  startedAt: number,
): Promise<Assessment> {
  /**
   * IP intelligence is resolved first and passed to every detector. It is the
   * only external call in the assessment, it has its own shorter timeout, and
   * four detectors read it — looking it up per detector would quadruple both
   * the latency and the merchant's provider bill.
   */
  const needsIpIntel =
    settings.checkVpn || settings.checkProxy || settings.checkTor || settings.checkIpReputation;

  const ipIntel = needsIpIntel ? await lookupIp(subject.ipAddress) : IP_INTEL_UNKNOWN;

  const now = new Date();
  const detectorSignals = await runDetectors({ subject, settings, ipIntel, now });

  const baseScore = detectorSignals.reduce((total, entry) => total + entry.weight, 0);

  /**
   * Merchant rules see the built-in score, so a rule can say "anything the
   * engine already scored above 40, in this state, needs a call". They run
   * after the detectors for exactly that reason.
   */
  const rules = await repository.listEnabledRules(subject.shopId).catch((error: unknown) => {
    log.error({ err: error, shopId: subject.shopId }, 'Could not load fraud rules');
    return [];
  });

  const ruleContext = toRuleContext(subject, clamp(baseScore), ipIntel.countryCode);
  const ruleResult = evaluateRules(rules, ruleContext);

  if (ruleResult.matchedRuleIds.length > 0) {
    // Fire-and-forget: the merchant's "has this rule ever matched" counter is
    // not worth delaying a shopper for.
    void repository.recordRuleMatches(ruleResult.matchedRuleIds).catch(() => undefined);
  }

  const signals = [...detectorSignals, ...ruleResult.signals];
  const score = clamp(signals.reduce((total, entry) => total + entry.weight, 0));

  const level = toLevel(score, settings);
  const thresholdAction = toAction(level, settings);
  const forcedAction = parseAction(ruleResult.forcedAction);

  /**
   * A rule's explicit action overrides the threshold-derived one — that is the
   * point of setting it. The exception is that it can never *weaken* a block
   * that came from a blacklist entry, since a blacklist is the merchant's most
   * explicit statement of intent and a broad rule should not quietly undo it.
   */
  const blacklisted = signals.some(
    (entry) => typeof entry.code === 'string' && entry.code.startsWith('BLACKLISTED_'),
  );

  const decided = blacklisted ? RiskAction.BLOCK : (forcedAction ?? thresholdAction);

  /**
   * A shopper who refused automated decision-making cannot be refused by the
   * engine alone — a BLOCK becomes a REVIEW, which is the same order held for a
   * person to judge rather than turned away by a score.
   *
   * Applied last, after the blacklist override, and deliberately: this is the
   * one thing that *does* outrank a blacklist entry, because a merchant's rule
   * cannot waive a right the shopper holds. It is also the only downgrade in
   * this file, and it is narrow — the order is still scored, the signals are
   * still recorded, and every other action passes through untouched. GDPR
   * Article 22 restricts decisions made solely by automated means, not the
   * analysis behind them.
   *
   * A REVIEW verdict produces a CONFIRMED order that the push gates hold back,
   * so no further plumbing is needed to make the merchant the decider.
   */
  const optedOutOfRefusal = subject.profilingOptOut && decided === RiskAction.BLOCK;
  const action = optedOutOfRefusal ? RiskAction.REVIEW : decided;

  if (optedOutOfRefusal) {
    signals.push({
      code: 'PROFILING_OPT_OUT',
      label: 'Shopper refused automated decisions — held for manual review instead of blocked',
      weight: 0,
      matched: true,
    });
  }

  const durationMs = Date.now() - startedAt;

  log.info(
    {
      shopId: subject.shopId,
      score,
      level,
      action,
      signalCount: signals.filter((entry) => entry.weight !== 0).length,
      durationMs,
    },
    'Risk assessment complete',
  );

  return {
    score,
    level,
    action,
    signals,
    matchedRuleIds: ruleResult.matchedRuleIds,
    ipIntel,
    durationMs,
    degraded: false,
  };
}

/**
 * Clamps to the published 0–100 range.
 *
 * Lower bound matters as much as the upper: a whitelist contributes −1000, and
 * a negative score would sort and display as nonsense in the admin.
 */
function clamp(score: number): number {
  return Math.max(RISK_SCORE_MIN, Math.min(RISK_SCORE_MAX, Math.round(score)));
}

export { FRAUD_ENGINE_VERSION };

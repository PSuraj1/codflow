import type { FraudRule } from '@prisma/client';
import { RiskSignal, type RiskSignalResult } from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import type { FraudSubject } from './types';

const log = createLogger('fraud-rules');

/**
 * Merchant-authored rules.
 *
 * Layered on top of the built-in detectors so a merchant can encode knowledge
 * the engine has no way to infer — "orders over ₹15,000 to this state need a
 * call first", "anything from this campaign is fine".
 *
 * Conditions are stored as JSON rather than as an expression string. A string
 * would need a parser, and a parser a merchant can write into is an evaluator
 * accepting untrusted input on the checkout path. The structure below can only
 * express comparisons.
 */

/** Values a rule may test against. Mirrors `RULE_FIELDS` in the contract. */
export interface RuleContext {
  readonly total: number;
  readonly subtotal: number;
  readonly itemCount: number;
  readonly itemQuantity: number;
  readonly currency: string;
  readonly countryCode: string | null;
  readonly province: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly email: string | null;
  readonly phone: string;
  /** The score so far, so a rule can act on the built-in detectors' output. */
  readonly riskScore: number;
  readonly ipCountryCode: string | null;
  readonly utmSource: string | null;
  readonly utmCampaign: string | null;
}

interface Condition {
  readonly field: string;
  readonly operator: string;
  readonly value?: unknown;
}

interface ConditionGroup {
  readonly all?: Condition[];
  readonly any?: Condition[];
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/**
 * Evaluates one comparison.
 *
 * Unknown operators return false rather than true — the opposite of the form
 * builder's conditional rules. The reasoning is inverted because the
 * consequence is: an unrecognised *visibility* rule failing open shows an extra
 * field, while an unrecognised *fraud* rule failing open would add points, or
 * an action, that the merchant never actually configured.
 */
function evaluateCondition(condition: Condition, context: RuleContext): boolean {
  const actual = (context as unknown as Record<string, unknown>)[condition.field];

  switch (condition.operator) {
    case 'equals':
      return asText(actual).toLowerCase() === asText(condition.value).toLowerCase();
    case 'not_equals':
      return asText(actual).toLowerCase() !== asText(condition.value).toLowerCase();
    case 'contains':
      return asText(actual).toLowerCase().includes(asText(condition.value).toLowerCase());
    case 'not_contains':
      return !asText(actual).toLowerCase().includes(asText(condition.value).toLowerCase());

    case 'in':
      return (
        Array.isArray(condition.value) &&
        condition.value.map((entry) => asText(entry).toLowerCase()).includes(asText(actual).toLowerCase())
      );
    case 'not_in':
      return (
        Array.isArray(condition.value) &&
        !condition.value.map((entry) => asText(entry).toLowerCase()).includes(asText(actual).toLowerCase())
      );

    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const left = asNumber(actual);
      const right = asNumber(condition.value);

      // A non-numeric comparison is a misconfigured rule, not a match. Letting
      // NaN through would make `total > 5000` true for an empty value.
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;

      if (condition.operator === 'gt') return left > right;
      if (condition.operator === 'lt') return left < right;
      if (condition.operator === 'gte') return left >= right;
      return left <= right;
    }

    case 'is_empty':
      return actual === null || actual === undefined || asText(actual).trim() === '';
    case 'is_not_empty':
      return actual !== null && actual !== undefined && asText(actual).trim() !== '';

    default:
      log.warn({ operator: condition.operator }, 'Unknown fraud rule operator — treating as no match');
      return false;
  }
}

function evaluateGroup(group: ConditionGroup, context: RuleContext): boolean {
  if (Array.isArray(group.all) && group.all.length > 0) {
    return group.all.every((condition) => evaluateCondition(condition, context));
  }

  if (Array.isArray(group.any) && group.any.length > 0) {
    return group.any.some((condition) => evaluateCondition(condition, context));
  }

  // An empty condition set matches nothing. A rule with no conditions that
  // applied to every order would be a merchant accidentally blocking their
  // whole store.
  return false;
}

export interface RuleEvaluation {
  readonly signals: readonly RiskSignalResult[];
  readonly matchedRuleIds: readonly string[];
  /** Set when a matching rule overrides the threshold-derived action. */
  readonly forcedAction: string | null;
}

/**
 * Evaluates every enabled rule.
 *
 * Rules are ordered by priority and the *first* one carrying an explicit action
 * wins. Later rules still contribute their score, so a merchant can stack
 * points from several rules while one of them decides the outcome.
 */
export function evaluateRules(rules: readonly FraudRule[], context: RuleContext): RuleEvaluation {
  const signals: RiskSignalResult[] = [];
  const matchedRuleIds: string[] = [];
  let forcedAction: string | null = null;

  for (const rule of rules) {
    let matched = false;

    try {
      matched = evaluateGroup((rule.conditions ?? {}) as ConditionGroup, context);
    } catch (error) {
      // A malformed rule must not fail the assessment — the order would be
      // blocked by a merchant's typo.
      log.error({ err: toError(error), ruleId: rule.id }, 'Fraud rule could not be evaluated');
      continue;
    }

    if (!matched) continue;

    matchedRuleIds.push(rule.id);

    signals.push({
      code: RiskSignal.CUSTOM_RULE,
      label: rule.reason ?? `Matched your rule "${rule.name}"`,
      weight: rule.scoreDelta,
      matched: true,
      detail: { ruleId: rule.id, ruleName: rule.name },
    });

    if (rule.action && !forcedAction) {
      forcedAction = rule.action;
    }
  }

  return { signals, matchedRuleIds, forcedAction };
}

/** Builds the rule context from a subject and the score so far. */
export function toRuleContext(subject: FraudSubject, riskScore: number, ipCountryCode: string | null): RuleContext {
  return {
    total: subject.total,
    subtotal: subject.subtotal,
    itemCount: subject.itemCount,
    itemQuantity: subject.itemQuantity,
    currency: subject.currency,
    countryCode: subject.countryCode,
    province: subject.province,
    city: subject.city,
    postalCode: subject.postalCode,
    email: subject.email,
    phone: subject.phone,
    riskScore,
    ipCountryCode,
    utmSource: subject.utmSource,
    utmCampaign: subject.utmCampaign,
  };
}

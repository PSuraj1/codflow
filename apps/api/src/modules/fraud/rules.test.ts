import type { FraudRule } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { evaluateRules, type RuleContext } from './rules';

/**
 * Merchant rule evaluation.
 *
 * A rule decides whether a real customer's order goes through, so the failure
 * that matters most here is a rule matching when it should not. Every ambiguous
 * case below resolves to *no match* — the opposite of the form builder's
 * conditional rules, and for the opposite reason: an unrecognised visibility
 * rule failing open shows an extra field, while an unrecognised fraud rule
 * failing open would add points the merchant never configured.
 */

function rule(overrides: Partial<FraudRule> = {}): FraudRule {
  return {
    id: 'rule-1',
    name: 'Test rule',
    isEnabled: true,
    priority: 100,
    conditions: { all: [{ field: 'total', operator: 'gt', value: 5000 }] },
    scoreDelta: 20,
    action: null,
    reason: null,
    matchCount: 0,
    lastMatchedAt: null,
    ...overrides,
  } as FraudRule;
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    total: 1000,
    subtotal: 900,
    itemCount: 1,
    currency: 'INR',
    countryCode: 'IN',
    province: 'MH',
    city: 'Pune',
    postalCode: '411001',
    email: 'a@example.com',
    phone: '+919876543210',
    riskScore: 0,
    ipCountryCode: 'IN',
    utmSource: null,
    utmCampaign: null,
    ...overrides,
  };
}

describe('operators', () => {
  it('matches a numeric comparison', () => {
    const result = evaluateRules([rule()], context({ total: 6000 }));
    expect(result.matchedRuleIds).toEqual(['rule-1']);
  });

  it('does not match when the comparison fails', () => {
    expect(evaluateRules([rule()], context({ total: 100 })).matchedRuleIds).toEqual([]);
  });

  it('compares strings case-insensitively', () => {
    const subject = rule({ conditions: { all: [{ field: 'countryCode', operator: 'equals', value: 'in' }] } });
    expect(evaluateRules([subject], context()).matchedRuleIds).toHaveLength(1);
  });

  it('supports in and not_in', () => {
    const inRule = rule({
      conditions: { all: [{ field: 'province', operator: 'in', value: ['MH', 'DL'] }] },
    });
    expect(evaluateRules([inRule], context()).matchedRuleIds).toHaveLength(1);

    const notIn = rule({
      conditions: { all: [{ field: 'province', operator: 'not_in', value: ['MH'] }] },
    });
    expect(evaluateRules([notIn], context()).matchedRuleIds).toEqual([]);
  });

  it('supports emptiness checks', () => {
    const empty = rule({ conditions: { all: [{ field: 'email', operator: 'is_empty' }] } });

    expect(evaluateRules([empty], context({ email: null })).matchedRuleIds).toHaveLength(1);
    expect(evaluateRules([empty], context()).matchedRuleIds).toEqual([]);
  });

  /**
   * `Number(null)` is 0, so without an explicit finiteness check a rule reading
   * `total > -1` would match an order with no total at all.
   */
  it('does not match a numeric comparison against a non-numeric value', () => {
    const subject = rule({ conditions: { all: [{ field: 'email', operator: 'gt', value: 0 }] } });
    expect(evaluateRules([subject], context()).matchedRuleIds).toEqual([]);
  });

  it('does not match an unknown operator', () => {
    const subject = rule({
      conditions: { all: [{ field: 'total', operator: 'approximately', value: 1000 }] },
    });
    expect(evaluateRules([subject], context()).matchedRuleIds).toEqual([]);
  });

  it('does not match an unknown field', () => {
    const subject = rule({
      conditions: { all: [{ field: 'nonExistent', operator: 'is_not_empty' }] },
    });
    expect(evaluateRules([subject], context()).matchedRuleIds).toEqual([]);
  });
});

describe('condition groups', () => {
  it('requires every condition under all', () => {
    const subject = rule({
      conditions: {
        all: [
          { field: 'total', operator: 'gt', value: 500 },
          { field: 'countryCode', operator: 'equals', value: 'AE' },
        ],
      },
    });

    expect(evaluateRules([subject], context()).matchedRuleIds).toEqual([]);
  });

  it('requires only one condition under any', () => {
    const subject = rule({
      conditions: {
        any: [
          { field: 'total', operator: 'gt', value: 500 },
          { field: 'countryCode', operator: 'equals', value: 'AE' },
        ],
      },
    });

    expect(evaluateRules([subject], context()).matchedRuleIds).toHaveLength(1);
  });

  /**
   * A rule with no conditions applying to every order would be a merchant
   * accidentally blocking their entire store.
   */
  it.each([
    ['an empty object', {}],
    ['an empty all list', { all: [] }],
    ['an empty any list', { any: [] }],
    ['null', null],
  ])('matches nothing for %s', (_label, conditions) => {
    const subject = rule({ conditions: conditions as never });
    expect(evaluateRules([subject], context()).matchedRuleIds).toEqual([]);
  });
});

describe('scoring and actions', () => {
  it('contributes the rule’s score delta', () => {
    const result = evaluateRules([rule({ scoreDelta: 35 })], context({ total: 6000 }));
    expect(result.signals[0]?.weight).toBe(35);
  });

  it('allows a negative delta so a merchant can express trust', () => {
    const trusted = rule({
      scoreDelta: -40,
      conditions: { all: [{ field: 'utmSource', operator: 'equals', value: 'newsletter' }] },
    });

    const result = evaluateRules([trusted], context({ utmSource: 'newsletter' }));
    expect(result.signals[0]?.weight).toBe(-40);
  });

  it('uses the merchant’s reason as the signal label', () => {
    const subject = rule({ reason: 'High-value order to a new customer', scoreDelta: 10 });
    const result = evaluateRules([subject], context({ total: 6000 }));

    expect(result.signals[0]?.label).toBe('High-value order to a new customer');
  });

  /**
   * Rules are ordered by priority and the first explicit action wins, but later
   * rules still contribute score — so a merchant can stack points from several
   * while one decides the outcome.
   */
  it('takes the action from the first rule that sets one', () => {
    const rules = [
      rule({ id: 'a', action: 'REVIEW', scoreDelta: 10 }),
      rule({ id: 'b', action: 'BLOCK', scoreDelta: 10 }),
    ] as FraudRule[];

    const result = evaluateRules(rules, context({ total: 6000 }));

    expect(result.forcedAction).toBe('REVIEW');
    expect(result.matchedRuleIds).toEqual(['a', 'b']);
    expect(result.signals).toHaveLength(2);
  });

  it('leaves the action unset when no rule specifies one', () => {
    expect(evaluateRules([rule()], context({ total: 6000 })).forcedAction).toBeNull();
  });

  it('reads riskScore so a rule can build on the detectors', () => {
    const subject = rule({
      conditions: { all: [{ field: 'riskScore', operator: 'gte', value: 40 }] },
    });

    expect(evaluateRules([subject], context({ riskScore: 45 })).matchedRuleIds).toHaveLength(1);
    expect(evaluateRules([subject], context({ riskScore: 10 })).matchedRuleIds).toEqual([]);
  });
});

describe('resilience', () => {
  it('skips a malformed rule rather than failing the assessment', () => {
    // A merchant's typo must not block checkout for everyone.
    const broken = rule({ id: 'broken', conditions: 'not-an-object' as never });
    const good = rule({ id: 'good', scoreDelta: 5 });

    const result = evaluateRules([broken, good], context({ total: 6000 }));
    expect(result.matchedRuleIds).toEqual(['good']);
  });

  it('returns an empty evaluation for no rules', () => {
    const result = evaluateRules([], context());

    expect(result.signals).toEqual([]);
    expect(result.matchedRuleIds).toEqual([]);
    expect(result.forcedAction).toBeNull();
  });
});

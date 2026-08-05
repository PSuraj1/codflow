import type { FraudSettings } from '@prisma/client';
import type { RiskSignalResult } from '@codflow/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scoring engine.
 *
 * Two properties are load-bearing and are what most of this file checks:
 *
 *  1. **It fails open.** Every internal failure resolves to an allow. A fraud
 *     engine that fails closed converts its own outage into a total checkout
 *     outage, and for a COD merchant that is a far larger loss than the fraud
 *     it exists to catch.
 *  2. **A blacklist cannot be weakened.** It is the merchant's most explicit
 *     statement of intent, and a broad scoring rule must not quietly undo it.
 *
 * The repository and detectors are mocked: this is about the arithmetic and the
 * decision table, not about SQL.
 */

const { getSettings, listEnabledRules, recordRuleMatches, runDetectors, lookupIp } = vi.hoisted(
  () => ({
    getSettings: vi.fn(),
    listEnabledRules: vi.fn(),
    recordRuleMatches: vi.fn(),
    runDetectors: vi.fn(),
    lookupIp: vi.fn(),
  }),
);

vi.mock('./repository', () => ({ getSettings, listEnabledRules, recordRuleMatches }));
vi.mock('./detectors', () => ({ runDetectors }));
vi.mock('../../lib/ipIntel', () => ({
  lookupIp,
  IP_INTEL_UNKNOWN: {
    countryCode: null,
    isVpn: null,
    isProxy: null,
    isTor: null,
    isHosting: null,
    reputationScore: null,
    resolved: false,
  },
}));

const { assess } = await import('./engine');
const { RiskAction, RiskLevel } = await import('@prisma/client');

function settings(overrides: Partial<FraudSettings> = {}): FraudSettings {
  return {
    isEnabled: true,
    mediumThreshold: 30,
    highThreshold: 60,
    criticalThreshold: 85,
    actionOnMedium: RiskAction.REVIEW,
    actionOnHigh: RiskAction.CHALLENGE_OTP,
    actionOnCritical: RiskAction.BLOCK,
    checkVpn: false,
    checkProxy: false,
    checkTor: false,
    checkIpReputation: false,
    ...overrides,
  } as FraudSettings;
}

const subject = {
  shopId: 'shop-1',
  shopDomain: 'demo.myshopify.com',
  codOrderId: null,
  phone: '+919876543210',
  phoneE164: '+919876543210',
  email: 'a@example.com',
  addressHash: 'hash',
  postalCode: '411001',
  countryCode: 'IN',
  province: 'MH',
  city: 'Pune',
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  deviceFingerprint: null,
  total: 1000,
  subtotal: 900,
  itemCount: 1,
  currency: 'INR',
  utmSource: null,
  utmCampaign: null,
  phoneIsValid: true,
  phoneType: 'MOBILE',
  profilingOptOut: false,
} as const;

function signals(...entries: Array<[string, number]>): RiskSignalResult[] {
  return entries.map(([code, weight]) => ({ code, label: code, weight, matched: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(settings());
  listEnabledRules.mockResolvedValue([]);
  recordRuleMatches.mockResolvedValue(undefined);
  runDetectors.mockResolvedValue([]);
  lookupIp.mockResolvedValue({
    countryCode: null,
    isVpn: null,
    isProxy: null,
    isTor: null,
    isHosting: null,
    reputationScore: null,
    resolved: false,
  });
});

describe('scoring', () => {
  it('allows an order with no signals', async () => {
    const result = await assess(subject);

    expect(result.score).toBe(0);
    expect(result.level).toBe(RiskLevel.LOW);
    expect(result.action).toBe(RiskAction.ALLOW);
  });

  it('sums signal weights', async () => {
    runDetectors.mockResolvedValue(signals(['DUPLICATE_PHONE', 18], ['NO_EMAIL', 4]));
    expect((await assess(subject)).score).toBe(22);
  });

  it('clamps above 100', async () => {
    runDetectors.mockResolvedValue(signals(['A', 80], ['B', 80]));
    expect((await assess(subject)).score).toBe(100);
  });

  /**
   * A whitelist contributes −1000. Without a lower clamp the score would be
   * negative, which sorts and renders as nonsense in the admin.
   */
  it('clamps below 0', async () => {
    runDetectors.mockResolvedValue(signals(['WHITELISTED', -1_000], ['DUPLICATE_PHONE', 18]));

    const result = await assess(subject);
    expect(result.score).toBe(0);
    expect(result.action).toBe(RiskAction.ALLOW);
  });
});

describe('thresholds', () => {
  it.each([
    [0, RiskLevel.LOW, RiskAction.ALLOW],
    [29, RiskLevel.LOW, RiskAction.ALLOW],
    [30, RiskLevel.MEDIUM, RiskAction.REVIEW],
    [59, RiskLevel.MEDIUM, RiskAction.REVIEW],
    [60, RiskLevel.HIGH, RiskAction.CHALLENGE_OTP],
    [84, RiskLevel.HIGH, RiskAction.CHALLENGE_OTP],
    [85, RiskLevel.CRITICAL, RiskAction.BLOCK],
    [100, RiskLevel.CRITICAL, RiskAction.BLOCK],
  ])('scores %i as %s with action %s', async (score, level, action) => {
    runDetectors.mockResolvedValue(signals(['X', score]));

    const result = await assess(subject);
    expect(result.level).toBe(level);
    expect(result.action).toBe(action);
  });

  it('honours a merchant’s custom thresholds', async () => {
    getSettings.mockResolvedValue(settings({ mediumThreshold: 10, highThreshold: 20, criticalThreshold: 30 }));
    runDetectors.mockResolvedValue(signals(['X', 25]));

    expect((await assess(subject)).level).toBe(RiskLevel.HIGH);
  });

  it('honours a merchant’s custom actions', async () => {
    getSettings.mockResolvedValue(settings({ actionOnMedium: RiskAction.BLOCK }));
    runDetectors.mockResolvedValue(signals(['X', 35]));

    expect((await assess(subject)).action).toBe(RiskAction.BLOCK);
  });
});

describe('merchant rules', () => {
  it('adds a matching rule’s score', async () => {
    listEnabledRules.mockResolvedValue([
      {
        id: 'r1',
        name: 'Big orders',
        conditions: { all: [{ field: 'total', operator: 'gt', value: 500 }] },
        scoreDelta: 40,
        action: null,
        reason: null,
      },
    ]);

    const result = await assess(subject);
    expect(result.score).toBe(40);
    expect(result.matchedRuleIds).toEqual(['r1']);
  });

  it('lets a rule override the threshold action', async () => {
    listEnabledRules.mockResolvedValue([
      {
        id: 'r1',
        name: 'Manual review',
        conditions: { all: [{ field: 'total', operator: 'gt', value: 500 }] },
        scoreDelta: 0,
        action: RiskAction.REVIEW,
        reason: null,
      },
    ]);

    // Score is 0, which would otherwise be ALLOW.
    expect((await assess(subject)).action).toBe(RiskAction.REVIEW);
  });

  it('gives rules the built-in score to build on', async () => {
    runDetectors.mockResolvedValue(signals(['DUPLICATE_PHONE', 45]));
    listEnabledRules.mockResolvedValue([
      {
        id: 'r1',
        name: 'Escalate anything already suspicious',
        conditions: { all: [{ field: 'riskScore', operator: 'gte', value: 40 }] },
        scoreDelta: 0,
        action: RiskAction.BLOCK,
        reason: null,
      },
    ]);

    expect((await assess(subject)).action).toBe(RiskAction.BLOCK);
  });
});

describe('blacklist precedence', () => {
  /**
   * A merchant blacklisting a number is not an inference — they looked at it
   * and decided. A scoring rule must not be able to walk that back.
   */
  it('blocks regardless of a rule trying to allow', async () => {
    runDetectors.mockResolvedValue(signals(['BLACKLISTED_PHONE', 100]));
    listEnabledRules.mockResolvedValue([
      {
        id: 'r1',
        name: 'Trust everything',
        conditions: { all: [{ field: 'total', operator: 'gt', value: 0 }] },
        scoreDelta: -100,
        action: RiskAction.ALLOW,
        reason: null,
      },
    ]);

    expect((await assess(subject)).action).toBe(RiskAction.BLOCK);
  });

  it('blocks even if the merchant set a lenient critical action', async () => {
    getSettings.mockResolvedValue(settings({ actionOnCritical: RiskAction.REVIEW }));
    runDetectors.mockResolvedValue(signals(['BLACKLISTED_EMAIL', 100]));

    expect((await assess(subject)).action).toBe(RiskAction.BLOCK);
  });
});

/**
 * The shopper's refusal of automated decision-making.
 *
 * Shopify's protected customer data rules oblige an app that scores shoppers to
 * let them refuse it, and GDPR Article 22 restricts decisions made *solely* by
 * automated means. Both are satisfied by putting a person in the loop rather
 * than by not scoring: the engine still runs, and only its power to refuse
 * outright is withdrawn.
 */
describe('profiling opt-out', () => {
  const optedOut = { ...subject, profilingOptOut: true };

  it('downgrades a block to review', async () => {
    getSettings.mockResolvedValue(settings({ actionOnCritical: RiskAction.BLOCK }));
    runDetectors.mockResolvedValue(signals(['VELOCITY', 90]));

    const result = await assess(optedOut);

    expect(result.action).toBe(RiskAction.REVIEW);
    // The analysis is untouched — the merchant still sees why.
    expect(result.score).toBe(90);
    expect(result.level).toBe(RiskLevel.CRITICAL);
  });

  /**
   * The one thing that outranks a blacklist. A merchant's list is their most
   * explicit statement of intent, but it cannot waive a right the shopper
   * holds — and the order is held for them to decide on, not let through.
   */
  it('downgrades a blacklist block to review', async () => {
    runDetectors.mockResolvedValue(signals(['BLACKLISTED_PHONE', 100]));

    expect((await assess(optedOut)).action).toBe(RiskAction.REVIEW);
  });

  it('records why the verdict was softened', async () => {
    runDetectors.mockResolvedValue(signals(['BLACKLISTED_PHONE', 100]));

    const result = await assess(optedOut);
    const optOut = result.signals.find((entry) => entry.code === 'PROFILING_OPT_OUT');

    expect(optOut).toBeDefined();
    // Weightless: it explains the decision, it does not change the score.
    expect(optOut?.weight).toBe(0);
  });

  /** Only a refusal is withdrawn. Everything milder passes through. */
  it.each([
    ['review', RiskAction.REVIEW, 90],
    ['an OTP challenge', RiskAction.CHALLENGE_OTP, 90],
    ['an allow', RiskAction.ALLOW, 0],
  ])('leaves %s alone', async (_label, expected, weight) => {
    getSettings.mockResolvedValue(settings({ actionOnCritical: expected }));
    runDetectors.mockResolvedValue(weight > 0 ? signals(['VELOCITY', weight]) : []);

    const result = await assess(optedOut);

    expect(result.action).toBe(expected);
    expect(result.signals.some((entry) => entry.code === 'PROFILING_OPT_OUT')).toBe(false);
  });

  it('still blocks a shopper who did not opt out', async () => {
    runDetectors.mockResolvedValue(signals(['BLACKLISTED_PHONE', 100]));

    expect((await assess(subject)).action).toBe(RiskAction.BLOCK);
  });
});

describe('fail-open guarantees', () => {
  it('allows when fraud protection is switched off', async () => {
    getSettings.mockResolvedValue(settings({ isEnabled: false }));
    runDetectors.mockResolvedValue(signals(['BLACKLISTED_PHONE', 100]));

    const result = await assess(subject);
    expect(result.action).toBe(RiskAction.ALLOW);
    expect(result.degraded).toBe(true);
    // Detectors are not even run.
    expect(runDetectors).not.toHaveBeenCalled();
  });

  it('allows when settings cannot be loaded', async () => {
    getSettings.mockRejectedValue(new Error('database is down'));

    const result = await assess(subject);
    expect(result.action).toBe(RiskAction.ALLOW);
    expect(result.degraded).toBe(true);
  });

  it('allows when the detectors throw', async () => {
    runDetectors.mockRejectedValue(new Error('detector exploded'));

    const result = await assess(subject);
    expect(result.action).toBe(RiskAction.ALLOW);
    expect(result.degraded).toBe(true);
  });

  it('still scores when the rules cannot be loaded', async () => {
    // Detector signals survive a rules failure — a partial assessment is a
    // usable one.
    runDetectors.mockResolvedValue(signals(['DUPLICATE_PHONE', 35]));
    listEnabledRules.mockRejectedValue(new Error('rules unavailable'));

    const result = await assess(subject);
    expect(result.score).toBe(35);
    expect(result.degraded).toBe(false);
  });

  it('records a reason on every degraded assessment', async () => {
    getSettings.mockRejectedValue(new Error('down'));

    const result = await assess(subject);
    expect(result.signals[0]?.code).toBe('ENGINE_SKIPPED');
    expect(result.signals[0]?.label).toBeTruthy();
  });
});

describe('IP intelligence', () => {
  it('is skipped when no network detector is enabled', async () => {
    // Avoids paying a provider for a lookup nothing will read.
    await assess(subject);
    expect(lookupIp).not.toHaveBeenCalled();
  });

  it('is resolved once when a network detector is enabled', async () => {
    getSettings.mockResolvedValue(settings({ checkTor: true }));

    await assess(subject);
    expect(lookupIp).toHaveBeenCalledTimes(1);
  });
});

describe('reporting', () => {
  it('reports how long the assessment took', async () => {
    expect((await assess(subject)).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns every signal, including zero-weight ones', async () => {
    runDetectors.mockResolvedValue(signals(['A', 10], ['B', 0]));
    expect((await assess(subject)).signals).toHaveLength(2);
  });
});

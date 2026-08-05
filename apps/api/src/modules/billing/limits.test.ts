import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan enforcement.
 *
 * The gates decide whether a merchant can do something they may have paid for,
 * so the properties worth testing are about *refusing correctly*:
 *
 *  - The refusal names the plan that would allow it. "Upgrade to continue"
 *    without saying to what wastes the merchant's time.
 *  - A cap of `null` means unlimited, and must never be compared numerically —
 *    `usage >= null` is `false` by luck, not by design.
 *  - The refusal on a shopper's checkout carries a machine-readable reason but
 *    no merchant billing detail, because the shopper is not the audience.
 */

const { effectivePlan } = vi.hoisted(() => ({ effectivePlan: vi.fn() }));
const { countPixels, countForms, countSheetConfigs, usageFor } = vi.hoisted(() => ({
  countPixels: vi.fn(),
  countForms: vi.fn(),
  countSheetConfigs: vi.fn(),
  usageFor: vi.fn(),
}));

vi.mock('./service', () => ({ effectivePlan }));
vi.mock('./repository', () => ({ countPixels, countForms, countSheetConfigs, usageFor }));
vi.mock('../../db/prisma', () => ({ prisma: {} }));

const { assertCanCreate, assertFeature, assertWithinUsage, checkUsage, hasFeature } = await import(
  './limits'
);
const { Plan } = await import('@prisma/client');

beforeEach(() => {
  vi.clearAllMocks();
  countPixels.mockResolvedValue(0);
  countForms.mockResolvedValue(0);
  countSheetConfigs.mockResolvedValue(0);
  usageFor.mockResolvedValue(0);
});

describe('assertFeature', () => {
  it('allows a feature the plan includes', async () => {
    effectivePlan.mockResolvedValue(Plan.STARTER);

    await expect(assertFeature('shop-1', 'fraudEngine')).resolves.toBeUndefined();
  });

  it('refuses and names the cheapest plan that would allow it', async () => {
    effectivePlan.mockResolvedValue(Plan.FREE);

    await expect(assertFeature('shop-1', 'fraudEngine')).rejects.toThrow(/Starter plan and above/);
  });

  it('names Pro for a feature Starter does not have either', async () => {
    effectivePlan.mockResolvedValue(Plan.STARTER);

    await expect(assertFeature('shop-1', 'customCss')).rejects.toThrow(/Pro plan and above/);
  });

  it('carries a machine-readable reason for the client to branch on', async () => {
    effectivePlan.mockResolvedValue(Plan.FREE);

    await assertFeature('shop-1', 'otpVerification').catch((error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      expect(details).toMatchObject({
        reason: 'FEATURE_NOT_IN_PLAN',
        currentPlan: Plan.FREE,
        requiredPlan: Plan.STARTER,
      });
    });

    expect.assertions(1);
  });
});

describe('hasFeature', () => {
  it('answers without throwing, for paths that shape a response instead of failing', async () => {
    effectivePlan.mockResolvedValue(Plan.PRO);
    expect(await hasFeature('shop-1', 'customCss')).toBe(true);

    effectivePlan.mockResolvedValue(Plan.FREE);
    expect(await hasFeature('shop-1', 'customCss')).toBe(false);
  });
});

describe('assertCanCreate', () => {
  it('allows creation below the cap', async () => {
    effectivePlan.mockResolvedValue(Plan.STARTER);
    countPixels.mockResolvedValue(2);

    await expect(assertCanCreate('shop-1', 'pixels')).resolves.toBeUndefined();
  });

  it('refuses at the cap and points at a bigger plan', async () => {
    effectivePlan.mockResolvedValue(Plan.STARTER);
    countPixels.mockResolvedValue(3);

    await expect(assertCanCreate('shop-1', 'pixels')).rejects.toThrow(/Pro plan includes more/);
  });

  it('never refuses on an unlimited plan, whatever the count', async () => {
    effectivePlan.mockResolvedValue(Plan.ENTERPRISE);
    countPixels.mockResolvedValue(9_999);

    // `null` is unlimited. A numeric comparison against it would be an accident
    // waiting for a refactor.
    await expect(assertCanCreate('shop-1', 'pixels')).resolves.toBeUndefined();
    expect(countPixels).not.toHaveBeenCalled();
  });

  it('says the ceiling has been hit rather than upselling a plan they are on', async () => {
    effectivePlan.mockResolvedValue(Plan.PRO);
    countForms.mockResolvedValue(10);

    // Pro allows 10 forms; Enterprise is unlimited, so the upsell is real here.
    await expect(assertCanCreate('shop-1', 'forms')).rejects.toThrow(/Enterprise plan includes more/);
  });
});

describe('checkUsage', () => {
  it('reports headroom without throwing', async () => {
    effectivePlan.mockResolvedValue(Plan.FREE);
    usageFor.mockResolvedValue(49);

    expect(await checkUsage('shop-1', 'cod_orders')).toMatchObject({
      allowed: true,
      used: 49,
      limit: 50,
    });
  });

  it('closes exactly at the cap, not one past it', async () => {
    effectivePlan.mockResolvedValue(Plan.FREE);
    usageFor.mockResolvedValue(50);

    expect((await checkUsage('shop-1', 'cod_orders')).allowed).toBe(false);
  });

  it('is always allowed, and reads nothing, when the metric is unmetered', async () => {
    effectivePlan.mockResolvedValue(Plan.ENTERPRISE);

    expect(await checkUsage('shop-1', 'cod_orders')).toMatchObject({ allowed: true, limit: null });
    expect(usageFor).not.toHaveBeenCalled();
  });
});

describe('assertWithinUsage', () => {
  it('passes below the cap', async () => {
    effectivePlan.mockResolvedValue(Plan.STARTER);
    usageFor.mockResolvedValue(10);

    await expect(assertWithinUsage('shop-1', 'cod_orders')).resolves.toBeUndefined();
  });

  it('explains both ways out — upgrade, or wait for the reset', async () => {
    effectivePlan.mockResolvedValue(Plan.FREE);
    usageFor.mockResolvedValue(50);

    await expect(assertWithinUsage('shop-1', 'cod_orders')).rejects.toThrow(
      /Upgrade, or the count resets/,
    );
  });

  it('points at a plan whose cap actually covers the next one', async () => {
    effectivePlan.mockResolvedValue(Plan.STARTER);
    usageFor.mockResolvedValue(500);

    await assertWithinUsage('shop-1', 'cod_orders').catch((error: unknown) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      // Starter caps at 500 and Pro at 5,000 — Pro is the honest suggestion.
      expect(details).toMatchObject({
        reason: 'USAGE_LIMIT_REACHED',
        requiredPlan: Plan.PRO,
        used: 500,
        limit: 500,
      });
    });

    expect.assertions(1);
  });
});

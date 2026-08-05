import { describe, expect, it, vi } from 'vitest';

/**
 * Plan exemption.
 *
 * The property that matters is the *default*: with nothing configured, every
 * shop is billed normally. A bug that inverted this would hand every merchant
 * who installs the app an enterprise plan, and the symptom — everything works —
 * is one nobody reports.
 */

const { config } = vi.hoisted(() => ({
  config: { billing: { exemptShops: [] as string[] } },
}));

vi.mock('../config/env', () => ({ config }));

/** Re-imports the module so the exempt set is rebuilt from the mocked config. */
async function load(shops: string[]) {
  config.billing.exemptShops = shops;
  vi.resetModules();
  return import('./planExemption');
}

describe('with nothing configured', () => {
  it('exempts nobody', async () => {
    const { isPlanExempt, hasPlanExemptions } = await load([]);

    expect(hasPlanExemptions()).toBe(false);
    expect(isPlanExempt('any-store.myshopify.com')).toBe(false);
  });

  it('leaves a resolved plan untouched', async () => {
    const { withPlanExemption } = await load([]);
    const { Plan } = await import('@codflow/shared');

    expect(withPlanExemption('any-store.myshopify.com', Plan.FREE)).toBe(Plan.FREE);
  });
});

describe('with an exempt shop', () => {
  const shops = ['dealzy-9cthr0cs.myshopify.com'];

  it('exempts it', async () => {
    const { isPlanExempt, hasPlanExemptions } = await load(shops);

    expect(hasPlanExemptions()).toBe(true);
    expect(isPlanExempt('dealzy-9cthr0cs.myshopify.com')).toBe(true);
  });

  /** The list is lower-cased on load; the lookup must be too. */
  it('matches regardless of case', async () => {
    const { isPlanExempt } = await load(shops);

    expect(isPlanExempt('DEALZY-9CTHR0CS.MyShopify.com')).toBe(true);
  });

  it('does not exempt any other shop', async () => {
    const { isPlanExempt } = await load(shops);

    expect(isPlanExempt('codkar-th9dk7h6.myshopify.com')).toBe(false);
    // The guard against a sloppy substring match: a domain that merely
    // contains an exempt one is a different shop.
    expect(isPlanExempt('evil-dealzy-9cthr0cs.myshopify.com')).toBe(false);
  });

  it.each([null, undefined, ''])('treats %s as not exempt', async (domain) => {
    const { isPlanExempt } = await load(shops);

    expect(isPlanExempt(domain)).toBe(false);
  });

  it('upgrades a resolved plan to the top one', async () => {
    const { withPlanExemption, EXEMPT_PLAN } = await load(shops);
    const { Plan } = await import('@codflow/shared');

    expect(withPlanExemption('dealzy-9cthr0cs.myshopify.com', Plan.FREE)).toBe(EXEMPT_PLAN);
    expect(withPlanExemption('codkar-th9dk7h6.myshopify.com', Plan.FREE)).toBe(Plan.FREE);
  });
});

describe('multiple shops', () => {
  it('exempts each of them', async () => {
    const { isPlanExempt } = await load(['a.myshopify.com', 'b.myshopify.com']);

    expect(isPlanExempt('a.myshopify.com')).toBe(true);
    expect(isPlanExempt('b.myshopify.com')).toBe(true);
    expect(isPlanExempt('c.myshopify.com')).toBe(false);
  });
});

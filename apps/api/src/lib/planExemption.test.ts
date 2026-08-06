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

// The module warns at import about entries that can never match. Stubbed
// because these tests are about the matching rule, not about logging — and the
// real logger reads config the mock above deliberately does not provide.
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

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

/**
 * People paste URLs, not domains.
 *
 * The value matched is `Shop.domain`, always the bare `*.myshopify.com` tenant
 * key — so an entry copied out of a browser address bar has to mean the same
 * thing as one typed by hand.
 */
describe('entry normalisation', () => {
  it.each([
    ['a bare domain', 'a7ypnk-vm.myshopify.com'],
    ['an https URL', 'https://a7ypnk-vm.myshopify.com'],
    ['a trailing slash', 'https://a7ypnk-vm.myshopify.com/'],
    ['http', 'http://a7ypnk-vm.myshopify.com/'],
    ['a path', 'https://a7ypnk-vm.myshopify.com/admin'],
    ['surrounding whitespace', '  a7ypnk-vm.myshopify.com	'],
    ['mixed case', 'A7YPNK-VM.MyShopify.com'],
  ])('accepts %s', async (_label, entry) => {
    const { isPlanExempt } = await load([entry]);

    expect(isPlanExempt('a7ypnk-vm.myshopify.com')).toBe(true);
  });

  it('drops entries that normalise to nothing', async () => {
    const { hasPlanExemptions } = await load(['', '   ', 'https://']);

    expect(hasPlanExemptions()).toBe(false);
  });

  /**
   * The trap this whole normalisation exists around.
   *
   * A shop is only ever identified by its permanent `*.myshopify.com` domain —
   * that is what `Shop.domain` stores and what every caller passes. So a custom
   * storefront domain in the config exempts nothing, however it is written, and
   * it does so silently. The boot warning is what makes it visible.
   */
  it('exempts no shop when configured with a custom storefront domain', async () => {
    const { isPlanExempt } = await load(['https://megastoreindia.com/']);

    // The store this was meant to cover, identified the way the app identifies it.
    expect(isPlanExempt('megastoreindia.myshopify.com')).toBe(false);
    expect(isPlanExempt('some-store.myshopify.com')).toBe(false);
  });
});

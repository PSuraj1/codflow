import type { Subscription } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Billing.
 *
 * The app never charges anyone — Shopify does — so what is under test here is
 * the part the app *is* responsible for, and every case below is a way of
 * getting entitlement wrong:
 *
 *  - Mapping a plan name to the wrong tier, which either short-changes a paying
 *    merchant or gives away paid features.
 *  - Treating a failed check as "no subscription", which downgrades a paying
 *    shop because of a network blip.
 *  - Forgetting that a frozen subscription is not an entitled one.
 *  - Averaging or mis-keying usage so a cap fires at the wrong moment.
 */

const { findByShop, reconcile: repoReconcile, reconcileToFree, usageForPeriod, recordUsage } =
  vi.hoisted(() => ({
    findByShop: vi.fn(),
    reconcile: vi.fn(),
    reconcileToFree: vi.fn(),
    usageForPeriod: vi.fn(),
    recordUsage: vi.fn(),
  }));

const { adminGraphql, loadOfflineSession } = vi.hoisted(() => ({
  adminGraphql: vi.fn(),
  loadOfflineSession: vi.fn(),
}));

vi.mock('./repository', async () => {
  const actual = await vi.importActual<typeof import('./repository')>('./repository');
  return {
    ...actual,
    findByShop,
    reconcile: repoReconcile,
    reconcileToFree,
    usageForPeriod,
    recordUsage,
  };
});

vi.mock('../../shopify/graphql', () => ({ adminGraphql }));
vi.mock('../../shopify/sessionStorage', () => ({ loadOfflineSession }));
vi.mock('../../db/prisma', () => ({ prisma: {} }));

const service = await import('./service');
const { Plan, SubscriptionStatus } = await import('@prisma/client');

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    shopId: 'shop-1',
    plan: Plan.PRO,
    status: SubscriptionStatus.ACTIVE,
    planHandle: 'Pro',
    shopifySubscriptionGid: 'gid://shopify/AppSubscription/1',
    trialEndsAt: null,
    currentPeriodEnd: null,
    isTest: false,
    lastVerifiedAt: new Date(),
    ...overrides,
  } as Subscription;
}

function shopifyResponse(overrides: Record<string, unknown> = {}) {
  return {
    currentAppInstallation: {
      activeSubscriptions: [
        {
          id: 'gid://shopify/AppSubscription/1',
          name: 'Pro',
          status: 'ACTIVE',
          test: false,
          trialDays: 0,
          createdAt: '2026-07-01T00:00:00Z',
          currentPeriodEnd: '2026-08-01T00:00:00Z',
          lineItems: [
            {
              plan: {
                pricingDetails: {
                  __typename: 'AppRecurringPricing',
                  interval: 'EVERY_30_DAYS',
                  price: { amount: '49.00', currencyCode: 'USD' },
                },
              },
            },
          ],
          ...overrides,
        },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadOfflineSession.mockResolvedValue({ shop: 'demo.myshopify.com' });
  repoReconcile.mockImplementation(async (_shopId: string, input: Record<string, unknown>) =>
    subscription(input as Partial<Subscription>),
  );
  reconcileToFree.mockResolvedValue(subscription({ plan: Plan.FREE }));
});

describe('resolvePlan', () => {
  it('matches the plan names in the catalogue', () => {
    expect(service.resolvePlan('Free')).toBe(Plan.FREE);
    expect(service.resolvePlan('Starter')).toBe(Plan.STARTER);
    expect(service.resolvePlan('Pro')).toBe(Plan.PRO);
    expect(service.resolvePlan('Enterprise')).toBe(Plan.ENTERPRISE);
  });

  it('tolerates the decoration a Partner Dashboard name picks up', () => {
    // These are all names a merchant-facing plan realistically ends up with.
    expect(service.resolvePlan('PRO')).toBe(Plan.PRO);
    expect(service.resolvePlan('  Starter  ')).toBe(Plan.STARTER);
    expect(service.resolvePlan('Pro — Annual')).toBe(Plan.PRO);
    expect(service.resolvePlan('Enterprise (USD)')).toBe(Plan.ENTERPRISE);
    expect(service.resolvePlan('CODkar Pro Monthly')).toBe(Plan.PRO);
  });

  it('falls back to the lowest paid tier, never to free, on an unknown name', () => {
    // A paying merchant getting slightly less than they bought is recoverable.
    // Dropping them to FREE mid-month is a refund and a one-star review.
    expect(service.resolvePlan('Something Nobody Configured')).toBe(Plan.STARTER);
  });
});

describe('resolveStatus', () => {
  it('distinguishes a trial from a paid subscription', () => {
    const future = new Date(Date.now() + 3 * 86_400_000);
    const past = new Date(Date.now() - 86_400_000);

    // Shopify reports both as ACTIVE; the distinction is ours to keep.
    expect(service.resolveStatus('ACTIVE', future)).toBe(SubscriptionStatus.TRIALING);
    expect(service.resolveStatus('ACTIVE', past)).toBe(SubscriptionStatus.ACTIVE);
    expect(service.resolveStatus('ACTIVE', null)).toBe(SubscriptionStatus.ACTIVE);
  });

  it('maps the states that end an entitlement', () => {
    expect(service.resolveStatus('FROZEN', null)).toBe(SubscriptionStatus.FROZEN);
    expect(service.resolveStatus('CANCELLED', null)).toBe(SubscriptionStatus.CANCELLED);
    expect(service.resolveStatus('EXPIRED', null)).toBe(SubscriptionStatus.EXPIRED);
  });
});

describe('reconcile', () => {
  it('caches what Shopify reports', async () => {
    adminGraphql.mockResolvedValue(shopifyResponse());

    await service.reconcile('shop-1', 'demo.myshopify.com');

    expect(repoReconcile).toHaveBeenCalledWith(
      'shop-1',
      expect.objectContaining({ plan: Plan.PRO, status: SubscriptionStatus.ACTIVE }),
    );
  });

  it('derives the trial end from the creation date and trial length', async () => {
    adminGraphql.mockResolvedValue(
      shopifyResponse({ trialDays: 7, createdAt: '2026-07-01T00:00:00Z' }),
    );

    await service.reconcile('shop-1', 'demo.myshopify.com');

    const input = repoReconcile.mock.calls[0]?.[1] as { trialEndsAt: Date };
    expect(input.trialEndsAt.toISOString()).toBe('2026-07-08T00:00:00.000Z');
  });

  it('drops a shop with no active subscription to free', async () => {
    adminGraphql.mockResolvedValue({ currentAppInstallation: { activeSubscriptions: [] } });

    await service.reconcile('shop-1', 'demo.myshopify.com');

    // A definite answer, so the verification stamp is still written.
    expect(reconcileToFree).toHaveBeenCalledWith('shop-1');
  });

  it('returns null rather than downgrading when Shopify cannot be reached', async () => {
    adminGraphql.mockRejectedValue(new Error('socket hang up'));

    const result = await service.reconcile('shop-1', 'demo.myshopify.com');

    // The critical case: a network blip must never look like a cancellation.
    expect(result).toBeNull();
    expect(reconcileToFree).not.toHaveBeenCalled();
    expect(repoReconcile).not.toHaveBeenCalled();
  });

  it('returns null when there is no session to ask with', async () => {
    loadOfflineSession.mockResolvedValue(null);

    expect(await service.reconcile('shop-1', 'demo.myshopify.com')).toBeNull();
    expect(reconcileToFree).not.toHaveBeenCalled();
  });
});

describe('reconcileIfStale', () => {
  it('skips the network call while the cache is fresh', async () => {
    findByShop.mockResolvedValue(subscription({ lastVerifiedAt: new Date() }));

    await service.reconcileIfStale('shop-1', 'demo.myshopify.com');

    expect(adminGraphql).not.toHaveBeenCalled();
  });

  it('re-checks once the cache has aged out', async () => {
    findByShop.mockResolvedValue(
      subscription({ lastVerifiedAt: new Date(Date.now() - service.STALE_AFTER_MS - 1_000) }),
    );
    adminGraphql.mockResolvedValue(shopifyResponse());

    await service.reconcileIfStale('shop-1', 'demo.myshopify.com');

    expect(adminGraphql).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached plan when the re-check fails', async () => {
    const cached = subscription({ plan: Plan.PRO, lastVerifiedAt: new Date(0) });
    findByShop.mockResolvedValue(cached);
    adminGraphql.mockRejectedValue(new Error('down'));

    const result = await service.reconcileIfStale('shop-1', 'demo.myshopify.com');

    expect(result?.plan).toBe(Plan.PRO);
  });
});

describe('effectivePlan', () => {
  it('is the subscribed plan while it is active or trialing', async () => {
    findByShop.mockResolvedValue(subscription({ plan: Plan.PRO }));
    expect(await service.effectivePlan('shop-1')).toBe(Plan.PRO);

    findByShop.mockResolvedValue(
      subscription({ plan: Plan.STARTER, status: SubscriptionStatus.TRIALING }),
    );
    expect(await service.effectivePlan('shop-1')).toBe(Plan.STARTER);
  });

  it('falls back to free for a subscription that is not currently paying', async () => {
    for (const status of [
      SubscriptionStatus.FROZEN,
      SubscriptionStatus.CANCELLED,
      SubscriptionStatus.EXPIRED,
      SubscriptionStatus.PENDING,
    ]) {
      findByShop.mockResolvedValue(subscription({ plan: Plan.PRO, status }));
      expect(await service.effectivePlan('shop-1')).toBe(Plan.FREE);
    }
  });

  it('is free when there is no subscription row at all', async () => {
    findByShop.mockResolvedValue(null);
    expect(await service.effectivePlan('shop-1')).toBe(Plan.FREE);
  });
});

describe('summariseUsage', () => {
  it('reports headroom against the plan’s caps', () => {
    const summary = service.summariseUsage(Plan.FREE, { cod_orders: 20 });
    const orders = summary.find((entry) => entry.metric === 'cod_orders');

    expect(orders).toMatchObject({ used: 20, limit: 50, percentUsed: 40, exceeded: false, nearLimit: false });
  });

  it('warns from 80% and stops at the cap', () => {
    const warned = service.summariseUsage(Plan.FREE, { cod_orders: 40 });
    expect(warned.find((entry) => entry.metric === 'cod_orders')).toMatchObject({
      nearLimit: true,
      exceeded: false,
    });

    const stopped = service.summariseUsage(Plan.FREE, { cod_orders: 50 });
    expect(stopped.find((entry) => entry.metric === 'cod_orders')).toMatchObject({
      nearLimit: true,
      exceeded: true,
    });
  });

  it('caps the percentage so an overage does not render past the end of the meter', () => {
    const summary = service.summariseUsage(Plan.FREE, { cod_orders: 500 });
    expect(summary.find((entry) => entry.metric === 'cod_orders')?.percentUsed).toBe(100);
  });

  it('reports an unmetered plan as unlimited rather than as zero', () => {
    const summary = service.summariseUsage(Plan.ENTERPRISE, { cod_orders: 90_000 });
    const orders = summary.find((entry) => entry.metric === 'cod_orders');

    expect(orders).toMatchObject({ limit: null, percentUsed: null, exceeded: false, nearLimit: false });
  });
});

describe('toSummary', () => {
  it('counts the days left of a trial', () => {
    const summary = service.toSummary(
      subscription({
        status: SubscriptionStatus.TRIALING,
        trialEndsAt: new Date(Date.now() + 3.5 * 86_400_000),
      }),
    );

    expect(summary.trialDaysRemaining).toBe(4);
  });

  it('never reports a negative trial countdown', () => {
    const summary = service.toSummary(
      subscription({ trialEndsAt: new Date(Date.now() - 5 * 86_400_000) }),
    );

    expect(summary.trialDaysRemaining).toBe(0);
  });

  it('describes a shop with no subscription as free and unverified', () => {
    const summary = service.toSummary(null);

    expect(summary).toMatchObject({ plan: Plan.FREE, planName: 'Free', lastVerifiedAt: null });
  });
});

describe('pricingPageUrl', () => {
  it('points at the managed pricing page for the shop and app', () => {
    expect(service.pricingPageUrl('demo.myshopify.com')).toBe(
      'https://admin.shopify.com/store/demo/charges/codflow/pricing_plans',
    );
  });
});

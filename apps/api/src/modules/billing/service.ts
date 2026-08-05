import { Plan, Prisma, SubscriptionStatus, type Subscription } from '@prisma/client';
import {
  PLAN_CATALOGUE,
  PLAN_LIMITS,
  USAGE_LABELS,
  USAGE_METRICS,
  USAGE_WARNING_THRESHOLD,
  type BillingOverview,
  type BillingSubscription,
  type UsageMetric,
  type UsageSummary,
} from '@codflow/shared';
import { config } from '../../config/env';
import { createLogger } from '../../lib/logger';
import { EXEMPT_PLAN, hasPlanExemptions, isPlanExempt } from '../../lib/planExemption';
import { toError } from '../../lib/errors';
import { shopHandle } from '../../lib/shopDomain';
import { adminGraphql } from '../../shopify/graphql';
import { loadOfflineSession } from '../../shopify/sessionStorage';
import {
  ACTIVE_SUBSCRIPTIONS_QUERY,
  type ActiveSubscriptionsResponse,
} from '../../shopify/queries/billing';
import * as repository from './repository';

const log = createLogger('billing');

/**
 * Billing.
 *
 * The app's job is enforcement and reconciliation; Shopify's job is money. What
 * that means in practice is that this module is mostly a *cache invalidation*
 * problem wearing a commercial hat, and the two failure directions are not
 * symmetrical:
 *
 *  - Cache says *lower* than reality → a merchant who just paid is still
 *    gated. Annoying, visible, and they will tell you.
 *  - Cache says *higher* than reality → a cancelled shop keeps paid features.
 *    Invisible, and it costs money for as long as it lasts.
 *
 * So reconciliation happens three ways, deliberately overlapping: on the
 * `app_subscriptions/update` webhook (immediate, and how a cancellation is
 * caught), lazily when a cached plan is older than `STALE_AFTER_MS`, and on
 * demand when the merchant returns from Shopify's pricing page.
 */

/** How long a cached plan is trusted before it is re-checked in the background. */
export const STALE_AFTER_MS = 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

/**
 * Maps Shopify's plan *name* onto this app's `Plan` enum.
 *
 * Managed pricing returns no plan identifier — only the display name configured
 * in the Partner Dashboard — so this mapping is a string match, and a merchant's
 * entitlements depend on it. That makes it the most fragile point in the whole
 * feature: rename a plan in the dashboard and every shop on it silently falls
 * back to FREE at the next reconciliation.
 *
 * Mitigations, in order:
 *  1. Matching is case- and whitespace-insensitive, and ignores anything after
 *     a separator, so "Pro — Annual" and "Pro (USD)" both resolve to PRO.
 *  2. An unrecognised name is *logged loudly* and treated as the lowest paid
 *     tier rather than FREE. A paying merchant getting slightly less than they
 *     bought is recoverable; one dropped to FREE mid-month is a refund and a
 *     one-star review.
 */
export function resolvePlan(planName: string): Plan {
  const normalized = planName
    .toLowerCase()
    .split(/[—–\-(/]/)[0]
    ?.trim();

  if (!normalized) return Plan.STARTER;

  for (const definition of PLAN_CATALOGUE) {
    if (definition.name.toLowerCase() === normalized) return definition.plan;
  }

  // Substring fallback, for a dashboard name like "CodFlow Pro Monthly".
  for (const definition of PLAN_CATALOGUE) {
    if (definition.plan === Plan.FREE) continue;
    if (normalized.includes(definition.name.toLowerCase())) return definition.plan;
  }

  log.error(
    { planName },
    'Shopify returned a plan name this app does not recognise — check the Partner Dashboard plan names against PLAN_CATALOGUE',
  );

  return Plan.STARTER;
}

/** Maps Shopify's subscription status string onto the local enum. */
export function resolveStatus(status: string, trialEndsAt: Date | null): SubscriptionStatus {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      // Shopify reports a trialing subscription as ACTIVE with trial days set.
      // Keeping the distinction locally is what lets the UI say "4 days left"
      // instead of implying the merchant is already paying.
      return trialEndsAt && trialEndsAt.getTime() > Date.now()
        ? SubscriptionStatus.TRIALING
        : SubscriptionStatus.ACTIVE;
    case 'FROZEN':
      return SubscriptionStatus.FROZEN;
    case 'CANCELLED':
      return SubscriptionStatus.CANCELLED;
    case 'EXPIRED':
      return SubscriptionStatus.EXPIRED;
    case 'PENDING':
    case 'ACCEPTED':
      return SubscriptionStatus.PENDING;
    default:
      return SubscriptionStatus.ACTIVE;
  }
}

/**
 * Whether a subscription entitles the shop to its plan's features right now.
 *
 * `FROZEN` is the one worth naming: Shopify freezes a subscription when the
 * merchant's own Shopify bill is unpaid. They have not cancelled and will
 * usually be back, so the right behaviour is to fall back to FREE limits while
 * keeping their configuration intact — not to delete anything.
 */
function isEntitled(status: SubscriptionStatus): boolean {
  return status === SubscriptionStatus.ACTIVE || status === SubscriptionStatus.TRIALING;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Asks Shopify what the shop is actually on, and caches the answer.
 *
 * Returns null when the question could not be asked — no session, or the API
 * was unreachable. Null is *not* "no subscription": the caller keeps the last
 * known plan rather than downgrading a paying merchant because of a network
 * blip. Losing a little revenue to a stale cache is recoverable; cutting off a
 * paying shop during their busy hour is not.
 */
export async function reconcile(shopId: string, shopDomain: string): Promise<Subscription | null> {
  try {
    const session = await loadOfflineSession(shopDomain);

    if (!session) {
      log.warn({ shop: shopDomain }, 'No offline session — cannot verify the subscription');
      return null;
    }

    const response = await adminGraphql<ActiveSubscriptionsResponse>(
      session,
      ACTIVE_SUBSCRIPTIONS_QUERY,
    );

    const subscriptions = response.currentAppInstallation?.activeSubscriptions ?? [];
    const active = subscriptions.find((entry) => entry.status.toUpperCase() !== 'CANCELLED');

    if (!active) {
      // A definite answer, not a failure: the shop is on the free plan.
      return repository.reconcileToFree(shopId);
    }

    const pricing = active.lineItems[0]?.plan.pricingDetails;
    const createdAt = new Date(active.createdAt);
    const trialEndsAt =
      active.trialDays > 0
        ? new Date(createdAt.getTime() + active.trialDays * 24 * 3_600_000)
        : null;

    const status = resolveStatus(active.status, trialEndsAt);

    const result = await repository.reconcile(shopId, {
      plan: resolvePlan(active.name),
      status,
      planHandle: active.name,
      shopifySubscriptionGid: active.id,
      price: pricing?.price ? new Prisma.Decimal(pricing.price.amount) : null,
      currencyCode: pricing?.price?.currencyCode ?? 'USD',
      interval: pricing?.interval ?? 'EVERY_30_DAYS',
      trialDays: active.trialDays,
      trialEndsAt,
      currentPeriodEnd: active.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null,
      isTest: active.test,
      activatedAt: createdAt,
      cancelledAt: status === SubscriptionStatus.CANCELLED ? new Date() : null,
    });

    log.info(
      { shop: shopDomain, plan: result.plan, status: result.status, test: result.isTest },
      'Subscription reconciled',
    );

    return result;
  } catch (error) {
    // Never throws at the caller. Billing verification failing must not take
    // down the request it was incidental to.
    log.error({ err: toError(error), shop: shopDomain }, 'Could not verify the subscription');
    return null;
  }
}

/**
 * Re-verifies only if the cached answer is old.
 *
 * Called from the session endpoint, so it runs on essentially every admin page
 * load — which is why it has to be cheap in the common case. `lastVerifiedAt`
 * makes the common case a single indexed read and no network call at all.
 */
export async function reconcileIfStale(
  shopId: string,
  shopDomain: string,
): Promise<Subscription | null> {
  const current = await repository.findByShop(shopId);

  if (current?.lastVerifiedAt && Date.now() - current.lastVerifiedAt.getTime() < STALE_AFTER_MS) {
    return current;
  }

  return (await reconcile(shopId, shopDomain)) ?? current;
}

// ---------------------------------------------------------------------------
// Reading the current plan
// ---------------------------------------------------------------------------

/**
 * The plan a shop's entitlements should be computed from.
 *
 * Not simply `subscription.plan`: a frozen or expired subscription resolves to
 * FREE, because the merchant is not currently paying. The row keeps its real
 * plan so the UI can say "your Pro plan is paused" rather than pretending they
 * were never a customer.
 */
export async function effectivePlan(shopId: string): Promise<Plan> {
  // Checked before the subscription is read, because an exempt shop may not
  // have one — and asked only when an exemption exists at all, so the ordinary
  // merchant path costs nothing.
  if (hasPlanExemptions() && isPlanExempt(await shopDomainFor(shopId))) {
    return EXEMPT_PLAN;
  }

  const subscription = await repository.findByShop(shopId);

  if (!subscription) return Plan.FREE;
  if (!isEntitled(subscription.status)) return Plan.FREE;

  return subscription.plan;
}

/**
 * Shop id to domain, cached for the process.
 *
 * The mapping never changes, and `effectivePlan` runs on every plan gate — a
 * lookup per gate would put a query in front of every feature check in the app.
 */
const domainCache = new Map<string, string>();

async function shopDomainFor(shopId: string): Promise<string | null> {
  const cached = domainCache.get(shopId);
  if (cached) return cached;

  const domain = await repository.findShopDomain(shopId);
  if (domain) domainCache.set(shopId, domain);

  return domain;
}

function trialDaysRemaining(trialEndsAt: Date | null): number | null {
  if (!trialEndsAt) return null;

  const remaining = Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 3_600_000));
  return remaining > 0 ? remaining : 0;
}

export function toSummary(subscription: Subscription | null): BillingSubscription {
  if (!subscription) {
    return {
      plan: Plan.FREE,
      status: SubscriptionStatus.ACTIVE,
      planName: 'Free',
      isTest: false,
      trialEndsAt: null,
      trialDaysRemaining: null,
      currentPeriodEnd: null,
      cancelledAt: null,
      lastVerifiedAt: null,
    };
  }

  const definition = PLAN_CATALOGUE.find((entry) => entry.plan === subscription.plan);

  return {
    plan: subscription.plan,
    status: subscription.status,
    planName: definition?.name ?? subscription.plan,
    isTest: subscription.isTest,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    trialDaysRemaining: trialDaysRemaining(subscription.trialEndsAt),
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    cancelledAt: subscription.cancelledAt?.toISOString() ?? null,
    lastVerifiedAt: subscription.lastVerifiedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const METERED: readonly { metric: UsageMetric; limitKey: keyof typeof PLAN_LIMITS.FREE }[] = [
  { metric: USAGE_METRICS.COD_ORDERS, limitKey: 'codOrders' },
  { metric: USAGE_METRICS.SHEET_SYNCS, limitKey: 'sheetSyncs' },
  { metric: USAGE_METRICS.OTP_SENDS, limitKey: 'otpSends' },
  { metric: USAGE_METRICS.PIXEL_EVENTS, limitKey: 'pixelEvents' },
];

export function summariseUsage(plan: Plan, used: Record<string, number>): UsageSummary[] {
  return METERED.map(({ metric, limitKey }) => {
    const limit = PLAN_LIMITS[plan][limitKey] as number | null;
    const quantity = used[metric] ?? 0;

    return {
      metric,
      label: USAGE_LABELS[metric] ?? metric,
      used: quantity,
      limit,
      percentUsed: limit === null ? null : Math.min(Math.round((quantity / limit) * 100), 100),
      exceeded: limit !== null && quantity >= limit,
      nearLimit: limit !== null && quantity >= limit * USAGE_WARNING_THRESHOLD,
    };
  });
}

/** Records consumption of a metered resource. Never throws at its caller. */
export async function recordUsage(
  shopId: string,
  metric: UsageMetric,
  quantity = 1,
): Promise<void> {
  try {
    const plan = await effectivePlan(shopId);
    const limitKey = METERED.find((entry) => entry.metric === metric)?.limitKey;
    const limit = limitKey ? ((PLAN_LIMITS[plan][limitKey] as number | null) ?? null) : null;

    await repository.recordUsage(shopId, metric, quantity, limit);
  } catch (error) {
    // A missed usage tick is a slightly generous cap for one merchant for one
    // month. A thrown error here would fail the order that caused it.
    log.error({ err: toError(error), shopId, metric }, 'Could not record usage');
  }
}

// ---------------------------------------------------------------------------
// The merchant-facing view
// ---------------------------------------------------------------------------

export async function overview(shopId: string): Promise<BillingOverview> {
  const [subscription, used] = await Promise.all([
    repository.findByShop(shopId),
    repository.usageForPeriod(shopId),
  ]);

  const plan = subscription && isEntitled(subscription.status) ? subscription.plan : Plan.FREE;
  const limits = PLAN_LIMITS[plan];

  const start = repository.periodStart();
  const end = repository.periodEnd();

  return {
    subscription: toSummary(subscription),
    catalogue: PLAN_CATALOGUE,
    usage: summariseUsage(plan, used),
    features: {
      fraudEngine: limits.fraudEngine,
      serverSideTracking: limits.serverSideTracking,
      otpVerification: limits.otpVerification,
      customCss: limits.customCss,
      prioritySupport: limits.prioritySupport,
    },
    periodStart: start.toISOString().slice(0, 10),
    // Shown as the last day of the period rather than the first of the next,
    // because "resets on 1 April" and "resets on 31 March" mean different things
    // to a merchant watching a cap.
    periodEnd: new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10),
  };
}

/**
 * Where a merchant goes to choose or change a plan.
 *
 * Managed pricing has no API to start a subscription — this Shopify-hosted page
 * is the only entry point, and it must open in the **top frame**. Shopify serves
 * it with `frame-ancestors 'none'`, so an in-iframe navigation renders an empty
 * panel and no error anywhere, which looks exactly like the button being broken.
 */
export function pricingPageUrl(shopDomain: string): string {
  return `https://admin.shopify.com/store/${shopHandle(shopDomain)}/charges/${
    config.shopify.appHandle
  }/pricing_plans`;
}

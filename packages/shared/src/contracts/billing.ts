import { Plan, SubscriptionStatus } from '../enums.js';
import { PLAN_LIMITS, type UsageMetric } from '../constants.js';

/**
 * The billing contract.
 *
 * CodFlow uses **Shopify managed pricing**: the plans, their prices and their
 * trials are configured in the Partner Dashboard, and Shopify runs the entire
 * purchase flow. The app never creates a charge, never sees a card, and never
 * needs the Billing API's `appSubscriptionCreate`.
 *
 * That splits the responsibility cleanly, and the split is the thing to
 * understand before changing anything here:
 *
 *   Shopify owns  — the price, the currency, the trial, the proration, the
 *                   invoice, the merchant's confirmation screen, and the
 *                   authoritative answer to "what are they on right now".
 *   CodFlow owns  — enforcement. Which features a plan unlocks, what the
 *                   monthly caps are, and what happens at the cap.
 *
 * The consequence is that `Subscription` in this app is a **cache**, not a
 * source of truth. It is reconciled from Shopify's own answer, and
 * `lastVerifiedAt` records when — so a stale cache is detectable rather than
 * silently authoritative. A merchant who upgrades and is still gated an hour
 * later is a support ticket; a merchant who cancels and keeps Pro features is
 * lost revenue. Both are reconciliation failures, and both are why the webhook
 * exists alongside the periodic check.
 */

/** What the pricing page renders. Prices are indicative — Shopify charges. */
export interface PlanDefinition {
  readonly plan: Plan;
  readonly name: string;
  /** One line under the name. Says who the plan is for, not what it contains. */
  readonly tagline: string;
  /**
   * Monthly price in USD, for display only.
   *
   * Shopify converts and charges in the merchant's own currency, so this is a
   * signpost rather than a quote — which is exactly why the upgrade button
   * hands off to Shopify's screen instead of trying to state a total here.
   *
   * **This number does not charge anyone.** The amount a merchant actually pays
   * is configured in the Partner Dashboard's managed pricing, and nothing in
   * this repository can read it back. Changing the price here without changing
   * it there produces the worst version of a billing bug: a merchant reads one
   * figure, agrees to it, and Shopify bills another. Change both, in the same
   * sitting, and check the app's pricing screen against Shopify's own upgrade
   * page afterwards.
   */
  readonly monthlyUsd: number;
  readonly trialDays: number;
  /** Bullet points, in the order they are shown. */
  readonly highlights: readonly string[];
}

/**
 * The plan catalogue.
 *
 * Kept beside `PLAN_LIMITS` deliberately: the numbers a merchant is *shown* and
 * the numbers the API *enforces* drifting apart is the worst failure this
 * feature has — someone pays for 5,000 orders and is cut off at 500. The
 * highlights are generated from `PLAN_LIMITS` wherever a number appears, so
 * they cannot disagree.
 */
function limitText(value: number | null, noun: string): string {
  return value === null ? `Unlimited ${noun}` : `${value.toLocaleString()} ${noun} a month`;
}

export const PLAN_CATALOGUE: readonly PlanDefinition[] = [
  {
    plan: Plan.FREE,
    name: 'Free',
    tagline: 'Try cash on delivery on your store',
    monthlyUsd: 0,
    trialDays: 0,
    highlights: [
      limitText(PLAN_LIMITS[Plan.FREE].codOrders, 'COD orders'),
      'COD form and buttons',
      'Google Sheets sync',
      'Client-side pixels',
    ],
  },
  {
    plan: Plan.STARTER,
    name: 'Starter',
    tagline: 'For stores taking COD orders every day',
    monthlyUsd: 9,
    trialDays: 3,
    highlights: [
      limitText(PLAN_LIMITS[Plan.STARTER].codOrders, 'COD orders'),
      'Fraud protection and risk scoring',
      'Server-side conversion tracking',
      'OTP verification',
      `${PLAN_LIMITS[Plan.STARTER].forms} COD forms`,
    ],
  },
  {
    plan: Plan.PRO,
    name: 'Pro',
    tagline: 'For stores where COD is the business',
    monthlyUsd: 18,
    trialDays: 3,
    highlights: [
      limitText(PLAN_LIMITS[Plan.PRO].codOrders, 'COD orders'),
      'Everything in Starter',
      'Custom CSS on the COD form',
      `${PLAN_LIMITS[Plan.PRO].pixels} pixels and ${PLAN_LIMITS[Plan.PRO].sheetConfigs} spreadsheets`,
    ],
  },
  {
    plan: Plan.ENTERPRISE,
    name: 'Enterprise',
    tagline: 'High volume, no caps',
    monthlyUsd: 26,
    trialDays: 0,
    highlights: [
      'Unlimited COD orders',
      'Everything in Pro',
      'Priority support',
      'Unlimited forms, pixels and spreadsheets',
    ],
  },
];

/** Where a plan sits relative to another. Drives "upgrade" vs "downgrade" wording. */
export const PLAN_RANK: Record<Plan, number> = {
  [Plan.FREE]: 0,
  [Plan.STARTER]: 1,
  [Plan.PRO]: 2,
  [Plan.ENTERPRISE]: 3,
};

/** One metered resource's position against its cap. */
export interface UsageSummary {
  readonly metric: UsageMetric;
  readonly label: string;
  readonly used: number;
  /** Null means unmetered on this plan. */
  readonly limit: number | null;
  /** 0–100, capped at 100. Null when unmetered. */
  readonly percentUsed: number | null;
  /** True once usage has reached the cap and the gate is closed. */
  readonly exceeded: boolean;
  /** True from 80% — the point at which a merchant should be told, not stopped. */
  readonly nearLimit: boolean;
}

/**
 * The merchant's current subscription, in full.
 *
 * Distinct from `SubscriptionSummary` in the auth contract, which is the
 * cut-down version the session endpoint returns on every page load. This one
 * carries what only the billing screen needs — the trial countdown, the
 * cancellation date, and when the plan was last confirmed against Shopify.
 */
export interface BillingSubscription {
  readonly plan: Plan;
  readonly status: SubscriptionStatus;
  readonly planName: string;
  readonly isTest: boolean;
  readonly trialEndsAt: string | null;
  readonly trialDaysRemaining: number | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelledAt: string | null;
  /**
   * When this was last confirmed against Shopify.
   *
   * Null means never — the shop has only ever been assumed FREE. Surfaced
   * because a plan decision made from an unverified cache is a decision that
   * could be wrong in the merchant's favour or against it.
   */
  readonly lastVerifiedAt: string | null;
}

/** `GET /api/admin/billing`. */
export interface BillingOverview {
  readonly subscription: BillingSubscription;
  readonly catalogue: readonly PlanDefinition[];
  readonly usage: readonly UsageSummary[];
  /** The features the current plan unlocks, for the UI to grey out the rest. */
  readonly features: {
    readonly fraudEngine: boolean;
    readonly serverSideTracking: boolean;
    readonly otpVerification: boolean;
    readonly customCss: boolean;
    readonly prioritySupport: boolean;
  };
  /** First day of the current billing month, `YYYY-MM-DD`. */
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * `POST /api/admin/billing/upgrade-url`.
 *
 * Managed pricing has no API call to start a subscription — the merchant is
 * sent to a Shopify-hosted page. **It must be opened in the top frame**:
 * Shopify serves it with `frame-ancestors 'none'`, so loading it inside the app
 * iframe renders an empty panel with no error anywhere.
 */
export interface UpgradeUrlResponse {
  readonly url: string;
  readonly plan: Plan | null;
}

/**
 * Why a request was refused on plan grounds.
 *
 * Separate codes because the merchant's next action differs: a feature gate
 * means upgrade, a cap means upgrade *or wait for the month to roll over*, and
 * conflating them produces an upsell for something they already have.
 */
export const BillingErrorCode = {
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  USAGE_LIMIT_REACHED: 'USAGE_LIMIT_REACHED',
} as const;

export type BillingErrorCode = (typeof BillingErrorCode)[keyof typeof BillingErrorCode];

/** Human names for the metered resources. Shown on the usage meters. */
export const USAGE_LABELS: Record<string, string> = {
  cod_orders: 'COD orders',
  sheet_syncs: 'Google Sheets syncs',
  otp_sends: 'OTP messages',
  pixel_events: 'Pixel events',
};

/** The point at which a merchant is warned rather than stopped. */
export const USAGE_WARNING_THRESHOLD = 0.8;

import { Plan } from '@prisma/client';
import {
  BillingErrorCode,
  PLAN_CATALOGUE,
  PLAN_LIMITS,
  PLAN_RANK,
  USAGE_LABELS,
  type PlanLimits,
  type UsageMetric,
} from '@codflow/shared';
import { ForbiddenError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import * as repository from './repository';
import { effectivePlan } from './service';

const log = createLogger('billing-limits');

/**
 * Plan enforcement — the surface every other module calls.
 *
 * Two kinds of limit, enforced differently on purpose:
 *
 *  - **Feature and entity gates** are hard, and they are *configuration-time*.
 *    A merchant adding a fourth pixel on a three-pixel plan is sitting in the
 *    admin looking at an upgrade button. Refusing is immediate, obvious, and
 *    costs them nothing but a decision.
 *
 *  - **Monthly usage caps** are also hard, but they sit on a shopper's
 *    checkout, and that changes what a good refusal looks like. The merchant is
 *    not in the room. So the cap is enforced, but everything is arranged so it
 *    is never a surprise: usage is surfaced on the dashboard, a warning starts
 *    at 80%, store health reports it, and the error that finally comes back
 *    carries a code the storefront renders as "cash on delivery is unavailable"
 *    rather than a stack trace.
 *
 * The alternative — silently allowing overage — was rejected. A cap nobody
 * enforces is not a cap, and discovering that only through an invoice dispute
 * is worse for the merchant than being stopped with an upgrade link.
 *
 * Every gate resolves the plan from `effectivePlan`, which already downgrades a
 * frozen or expired subscription to FREE. Nothing in this file needs to know
 * about subscription status.
 */

/** Feature flags a plan can unlock. Keys of `PlanLimits` that are booleans. */
export type PlanFeature = {
  [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never;
}[keyof PlanLimits];

/** Countable things a plan caps. Keys of `PlanLimits` that are numbers. */
export type PlanEntity = 'pixels' | 'forms' | 'sheetConfigs' | 'automations';

const FEATURE_LABELS: Record<PlanFeature, string> = {
  serverSideTracking: 'Server-side conversion tracking',
  fraudEngine: 'Fraud protection',
  otpVerification: 'OTP verification',
  customCss: 'Custom CSS',
  prioritySupport: 'Priority support',
};

const ENTITY_LABELS: Record<PlanEntity, string> = {
  pixels: 'pixels',
  forms: 'COD forms',
  sheetConfigs: 'connected spreadsheets',
  automations: 'automations',
};

/** The cheapest plan that includes a feature — what the upsell should name. */
function cheapestPlanWith(feature: PlanFeature): Plan {
  const candidates = PLAN_CATALOGUE.map((entry) => entry.plan)
    .filter((plan) => PLAN_LIMITS[plan][feature] === true)
    .sort((left, right) => PLAN_RANK[left] - PLAN_RANK[right]);

  return candidates[0] ?? Plan.ENTERPRISE;
}

/** The cheapest plan whose cap on `entity` exceeds `needed`. */
function cheapestPlanFor(entity: PlanEntity, needed: number): Plan {
  const candidates = PLAN_CATALOGUE.map((entry) => entry.plan)
    .filter((plan) => {
      const limit = PLAN_LIMITS[plan][entity];
      return limit === null || limit >= needed;
    })
    .sort((left, right) => PLAN_RANK[left] - PLAN_RANK[right]);

  return candidates[0] ?? Plan.ENTERPRISE;
}

function planName(plan: Plan): string {
  return PLAN_CATALOGUE.find((entry) => entry.plan === plan)?.name ?? plan;
}

/**
 * Whether a plan includes a feature. Read-only — for shaping a response.
 *
 * Used where the honest answer is to return *less*, not to fail: the storefront
 * config omits custom CSS on a plan without it rather than erroring, because the
 * shopper is not the one who needs to know.
 */
export async function hasFeature(shopId: string, feature: PlanFeature): Promise<boolean> {
  const plan = await effectivePlan(shopId);
  return PLAN_LIMITS[plan][feature] === true;
}

/**
 * Refuses unless the plan includes a feature.
 *
 * The error names the plan that would unlock it, because "upgrade to continue"
 * without saying to what is the most common way an upsell wastes a merchant's
 * time.
 */
export async function assertFeature(shopId: string, feature: PlanFeature): Promise<void> {
  const plan = await effectivePlan(shopId);
  if (PLAN_LIMITS[plan][feature] === true) return;

  const required = cheapestPlanWith(feature);

  throw new ForbiddenError(
    `${FEATURE_LABELS[feature]} is available on the ${planName(required)} plan and above.`,
    {
      details: {
        reason: BillingErrorCode.FEATURE_NOT_IN_PLAN,
        feature,
        currentPlan: plan,
        requiredPlan: required,
      },
    },
  );
}

const COUNTERS: Record<PlanEntity, (shopId: string) => Promise<number>> = {
  pixels: repository.countPixels,
  forms: repository.countForms,
  sheetConfigs: repository.countSheetConfigs,
  // Automations have no model of their own yet; the gate is wired so the phase
  // that adds them does not have to touch this file.
  automations: async () => 0,
};

/**
 * Refuses when creating one more would exceed the plan's cap.
 *
 * Counted at the moment of creation rather than tracked, so it cannot drift: a
 * merchant who deletes a pixel immediately gets the slot back, and no
 * reconciliation is needed between a counter and reality.
 */
export async function assertCanCreate(shopId: string, entity: PlanEntity): Promise<void> {
  const plan = await effectivePlan(shopId);
  const limit = PLAN_LIMITS[plan][entity];

  if (limit === null) return;

  const current = await COUNTERS[entity](shopId);
  if (current < limit) return;

  const required = cheapestPlanFor(entity, current + 1);
  const atCeiling = required === plan;

  throw new ForbiddenError(
    atCeiling
      ? `You have reached the maximum of ${limit} ${ENTITY_LABELS[entity]}.`
      : `Your ${planName(plan)} plan includes ${limit} ${ENTITY_LABELS[entity]}. The ${planName(
          required,
        )} plan includes more.`,
    {
      details: {
        reason: BillingErrorCode.PLAN_LIMIT_REACHED,
        entity,
        limit,
        current,
        currentPlan: plan,
        requiredPlan: required,
      },
    },
  );
}

/** Maps a usage metric onto the `PlanLimits` key that caps it. */
function limitKeyFor(metric: UsageMetric): 'codOrders' | 'sheetSyncs' | 'otpSends' | 'pixelEvents' {
  switch (metric) {
    case 'cod_orders':
      return 'codOrders';
    case 'sheet_syncs':
      return 'sheetSyncs';
    case 'otp_sends':
      return 'otpSends';
    default:
      return 'pixelEvents';
  }
}

/** The cheapest plan whose monthly cap on `metric` covers `needed`. */
function cheapestPlanForUsage(metric: UsageMetric, needed: number): Plan {
  const key = limitKeyFor(metric);

  const candidates = PLAN_CATALOGUE.map((entry) => entry.plan)
    .filter((plan) => {
      const limit = PLAN_LIMITS[plan][key] as number | null;
      return limit === null || limit >= needed;
    })
    .sort((left, right) => PLAN_RANK[left] - PLAN_RANK[right]);

  return candidates[0] ?? Plan.ENTERPRISE;
}

export interface UsageVerdict {
  readonly allowed: boolean;
  readonly used: number;
  readonly limit: number | null;
  readonly plan: Plan;
}

/**
 * Whether a metered action is still within the month's cap.
 *
 * Returns a verdict rather than throwing, because two callers want different
 * things from the same answer: the storefront wants to stop, and the dashboard
 * wants to warn. `assertWithinUsage` is the throwing form.
 */
export async function checkUsage(shopId: string, metric: UsageMetric): Promise<UsageVerdict> {
  const plan = await effectivePlan(shopId);
  const limit = PLAN_LIMITS[plan][limitKeyFor(metric)] as number | null;
  if (limit === null) return { allowed: true, used: 0, limit: null, plan };

  const used = await repository.usageFor(shopId, metric);

  return { allowed: used < limit, used, limit, plan };
}

/**
 * Refuses a metered action that would exceed the month's cap.
 *
 * The one gate that can fire on a shopper's checkout. `PLAN_LIMIT_REACHED`
 * carries no merchant-specific detail into the storefront response — the
 * shopper is not the audience, and telling them the store is on a free plan
 * that ran out is nobody's idea of a good checkout experience. The controller
 * translates this into a neutral "cash on delivery is unavailable".
 */
export async function assertWithinUsage(shopId: string, metric: UsageMetric): Promise<void> {
  const verdict = await checkUsage(shopId, metric);
  if (verdict.allowed) return;

  const required = cheapestPlanForUsage(metric, verdict.used + 1);

  log.warn(
    { shopId, metric, used: verdict.used, limit: verdict.limit, plan: verdict.plan },
    'Monthly plan limit reached — action refused',
  );

  throw new ForbiddenError(
    `Your plan includes ${verdict.limit?.toLocaleString()} ${
      USAGE_LABELS[metric] ?? metric
    } a month and you have used them all. Upgrade, or the count resets at the start of next month.`,
    {
      details: {
        reason: BillingErrorCode.USAGE_LIMIT_REACHED,
        metric,
        used: verdict.used,
        limit: verdict.limit,
        currentPlan: verdict.plan,
        requiredPlan: required,
      },
    },
  );
}

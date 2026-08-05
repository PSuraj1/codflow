import { Plan } from '@codflow/shared';
import { config } from '../config/env';

/**
 * Shops that ignore plan limits.
 *
 * A public app bills every merchant who installs it, and that correctly
 * includes the shops its own operator runs. It is the wrong answer for those
 * shops: nobody wants their own store refusing its fifty-first COD order, or
 * their own fraud engine switched off because the Free tier does not include
 * it.
 *
 * Configured as `PLAN_EXEMPT_SHOPS` — a comma-separated list of myshopify
 * domains — and applied at the point every gate already reads the plan, so a
 * feature added later is exempt without anyone remembering to exempt it.
 *
 * Two properties matter:
 *
 *  1. **It is environment, not data.** A row granting unlimited entitlements is
 *     lost when the database is rebuilt (which has happened here) and can be
 *     written by anything holding an admin session. A deployment variable can
 *     do neither.
 *  2. **It is empty by default.** Every other merchant is billed normally, and
 *     a deployment that forgets to set it bills the operator rather than
 *     accidentally giving the world an enterprise plan.
 */

/**
 * What an exempt shop gets.
 *
 * The top plan rather than a fourth "unlimited" state, so nothing downstream
 * has to learn a new case: `PLAN_LIMITS[ENTERPRISE]` already means every
 * feature on and the highest ceilings, and the admin renders it like any other
 * plan.
 */
export const EXEMPT_PLAN = Plan.ENTERPRISE;

const exempt = new Set(config.billing.exemptShops);

/** True when any exemption is configured. Lets callers skip a lookup entirely. */
export function hasPlanExemptions(): boolean {
  return exempt.size > 0;
}

/** True when this shop should ignore plan limits. */
export function isPlanExempt(shopDomain: string | null | undefined): boolean {
  if (!shopDomain || exempt.size === 0) return false;
  return exempt.has(shopDomain.toLowerCase());
}

/**
 * Applies the exemption to a resolved plan.
 *
 * Takes the plan the normal rules produced so the caller reads as "this, unless
 * exempt" — which is what keeps the exemption from quietly becoming the primary
 * path if the list is ever misconfigured.
 */
export function withPlanExemption(shopDomain: string | null | undefined, plan: Plan): Plan {
  return isPlanExempt(shopDomain) ? EXEMPT_PLAN : plan;
}

import { z } from 'zod';

/**
 * Billing request contracts.
 *
 * Deliberately tiny. Under managed pricing the app cannot start, price or
 * cancel a subscription — every one of those is a Shopify-hosted flow — so
 * there is no "create subscription" body to validate and no place a client
 * could assert what it is entitled to. The only input the merchant supplies is
 * which plan they were looking at when they pressed upgrade, and that is a hint
 * for the redirect, not a claim.
 */

const PLANS = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'] as const;

/**
 * Which plan the merchant clicked.
 *
 * Optional, and never trusted as an entitlement: it only decides which plan the
 * Shopify pricing page highlights. What the merchant actually ends up on is
 * whatever they confirm on Shopify's own screen, which the app then learns from
 * reconciliation.
 */
export const UpgradeUrlSchema = z.object({
  plan: z.enum(PLANS).optional(),
});

export type UpgradeUrlInput = z.infer<typeof UpgradeUrlSchema>;

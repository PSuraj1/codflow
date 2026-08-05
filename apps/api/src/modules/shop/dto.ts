import { z } from 'zod';
import { LOGO_ALIGNMENTS, LOGO_HEIGHT_MAX, LOGO_HEIGHT_MIN } from '@codflow/shared';

/**
 * Shop module contracts.
 *
 * Zod schemas rather than plain types because these describe *inbound* data.
 * The inferred types are the module's public request surface.
 */

/**
 * Onboarding progress.
 *
 * `step` is bounded rather than free-form so a client bug cannot park a shop on
 * step 4000 and permanently hide the setup guide. The ceiling matches the
 * number of steps in the checklist and moves with it.
 */
/**
 * Hex only, for the same reason the button colours are.
 *
 * Every one of these is written into a CSS custom property on the storefront,
 * so a value able to carry a `;` writes arbitrary declarations into the
 * merchant's own page.
 */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour such as #008060');

export const UpdateBrandingSchema = z.object({
  primaryColor: hexColor.optional(),
  secondaryColor: hexColor.optional(),
  textColor: hexColor.optional(),

  // A font stack, not a font file. Length-capped rather than pattern-matched:
  // stacks legitimately contain quotes, commas and spaces.
  fontFamily: z.string().trim().min(1).max(200).optional(),

  borderRadius: z.number().int().min(0).max(60).optional(),

  // Rendered into an <img src> on a shopper's page, so it must not be able to
  // carry `javascript:` or a data URL.
  logoUrl: z.url().max(500).refine((value) => value.startsWith('https://'), {
    message: 'The logo must be served over https',
  }).nullish(),

  // Bounds live in the shared package so the admin's slider and this check
  // cannot drift into disagreeing about what a merchant may save.
  logoHeight: z.number().int().min(LOGO_HEIGHT_MIN).max(LOGO_HEIGHT_MAX).optional(),

  logoAlignment: z.enum(LOGO_ALIGNMENTS).optional(),

  customCss: z.string().max(10_000).nullish(),

  themeMode: z.enum(['LIGHT', 'DARK', 'SYSTEM']).optional(),
});

export type UpdateBrandingInput = z.infer<typeof UpdateBrandingSchema>;

/** A Shopify GID. Anything else would not match what the storefront compares against. */
const gid = z.string().regex(/^gid:\/\/shopify\/(Product|Collection)\/\d+$/, 'Not a Shopify product or collection ID');

/** ISO 3166-1 alpha-2, upper-cased so a lower-case entry still matches. */
const country = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/)
  .transform((value) => value.toUpperCase());

/**
 * Decimal money as a string.
 *
 * Never a number: a float loses paise, and these bounds are compared against an
 * order total the server resolved from Shopify.
 */
const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use a number such as 499 or 499.50')
  .nullish();

export const UpdateVisibilitySchema = z.object({
  codEnabled: z.boolean().optional(),
  replaceAddToCart: z.boolean().optional(),
  replaceBuyNow: z.boolean().optional(),

  enabledOnAllProducts: z.boolean().optional(),
  includedProductGids: z.array(gid).max(500).optional(),
  excludedProductGids: z.array(gid).max(500).optional(),
  includedCollectionGids: z.array(gid).max(250).optional(),

  allowedCountryCodes: z.array(country).max(250).optional(),
  blockedCountryCodes: z.array(country).max(250).optional(),

  // Prefixes, not regexes. A merchant-authored regular expression running on
  // the checkout path is the trap `forms/dto.ts` already guards against.
  allowedPostalPatterns: z.array(z.string().trim().min(1).max(20)).max(1_000).optional(),
  blockedPostalPatterns: z.array(z.string().trim().min(1).max(20)).max(1_000).optional(),

  minOrderValue: money,
  maxOrderValue: money,
});

export type UpdateVisibilityInput = z.infer<typeof UpdateVisibilitySchema>;

/**
 * What COD costs the shopper.
 *
 * Amounts reuse the `money` string schema for the reason it exists: these are
 * added to an order total the server resolved from Shopify, and a float loses
 * paise. `nullish` throughout, because clearing a fee is a real edit — null is
 * "charge nothing", which is different from "leave it alone".
 */
export const UpdateFeesSchema = z.object({
  codFeeEnabled: z.boolean().optional(),
  codFeeIsPercent: z.boolean().optional(),

  /**
   * Doubles as a percentage when `codFeeIsPercent` is set, so the ceiling has
   * to accommodate both. The cross-field check that a percentage is not above
   * 100 lives in the service, where the *stored* value of the other field is
   * known — a merchant may PATCH either one alone.
   */
  codFeeAmount: money,

  shippingFee: money,
  freeShippingAbove: money,
});

export type UpdateFeesInput = z.infer<typeof UpdateFeesSchema>;

export const UpdateOnboardingSchema = z.object({
  step: z.coerce.number().int().min(0).max(10),
  completed: z.boolean().default(false),
});

export type UpdateOnboardingInput = z.infer<typeof UpdateOnboardingSchema>;

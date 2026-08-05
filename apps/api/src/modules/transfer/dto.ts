import { z } from 'zod';
import { LOGO_ALIGNMENTS, LOGO_HEIGHT_MAX, LOGO_HEIGHT_MIN } from '@codflow/shared';

/**
 * The import boundary.
 *
 * This file is the only thing standing between a merchant-supplied JSON file
 * and a `prisma.update`, which makes it the security boundary of the whole
 * feature — an uploaded settings file is untrusted input in exactly the way a
 * form submission is, and more dangerous, because it writes many columns at
 * once.
 *
 * Three properties are deliberate:
 *
 *  1. **Allow-list, never pass-through.** Every field is named. Zod strips
 *     anything else, so a file carrying `shopId`, `id`, `accessTokenEnc` or a
 *     column added in a later phase cannot reach the database by being present
 *     in the payload.
 *  2. **Bounds match the real screens.** The same colour, length and range
 *     checks the admin enforces — an import must not be a way around validation
 *     that a merchant cannot get around through the UI.
 *  3. **Everything is optional.** A file from an older version, or one a
 *     merchant has hand-edited down to the two screens they care about, applies
 *     what it has and leaves the rest untouched.
 */

const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour such as #008060');

/** Decimal money as a string. Never a number — a float loses paise. */
const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use a number such as 499 or 499.50')
  .nullish();

/**
 * An https URL.
 *
 * `z.url()` alone accepts `http:`, and the logo is rendered into an `<img src>`
 * on a shopper's page — the same reason `shop/dto.ts` refuses anything else. An
 * import that accepted a plain-http logo would be a way around a rule the
 * Appearance screen enforces, which is exactly what this file exists to prevent.
 */
const httpsUrl = z
  .url()
  .max(500)
  .refine((value) => value.startsWith('https://'), { message: 'The URL must use https' });

const gid = z.string().regex(/^gid:\/\/shopify\/(Product|Collection)\/\d+$/);
const country = z.string().length(2).toUpperCase();
const locale = z.enum(['EN', 'HI', 'AR', 'FR', 'ES', 'PT', 'DE', 'ID', 'TR', 'VI', 'TH', 'BN']);

const SettingsSchema = z
  .object({
    codEnabled: z.boolean(),
    replaceAddToCart: z.boolean(),
    replaceBuyNow: z.boolean(),

    enabledOnAllProducts: z.boolean(),
    includedProductGids: z.array(gid).max(500),
    excludedProductGids: z.array(gid).max(500),
    includedCollectionGids: z.array(gid).max(250),

    codFeeEnabled: z.boolean(),
    codFeeAmount: money,
    codFeeIsPercent: z.boolean(),
    minOrderValue: money,
    maxOrderValue: money,
    freeShippingAbove: money,
    shippingFee: money,

    defaultOrderTags: z.array(z.string().trim().min(1).max(60)).max(50),
    createAsDraftOrder: z.boolean(),
    autoFulfill: z.boolean(),
    markAsPaid: z.boolean(),
    inventoryBehaviour: z.enum(['bypass', 'decrement_ignoring_policy', 'decrement_obeying_policy']),
    sendShopifyOrderConfirmation: z.boolean(),

    brandPrimaryColor: hexColor,
    brandSecondaryColor: hexColor,
    brandTextColor: hexColor,
    brandFontFamily: z.string().trim().min(1).max(200),
    brandBorderRadius: z.number().int().min(0).max(60),
    brandLogoUrl: httpsUrl.nullable(),
    brandLogoHeight: z.number().int().min(LOGO_HEIGHT_MIN).max(LOGO_HEIGHT_MAX),
    brandLogoAlignment: z.enum(LOGO_ALIGNMENTS),
    customCss: z.string().max(10_000).nullable(),
    themeMode: z.enum(['LIGHT', 'DARK', 'SYSTEM']),

    defaultLocale: locale,
    enabledLocales: z.array(locale).max(20),
    forceRtl: z.boolean(),
    currencyFormat: z.string().max(100),
    dateFormat: z.string().max(40),

    allowedCountryCodes: z.array(country).max(250),
    blockedCountryCodes: z.array(country).max(250),
    allowedPostalPatterns: z.array(z.string().trim().min(1).max(20)).max(1_000),
    blockedPostalPatterns: z.array(z.string().trim().min(1).max(20)).max(1_000),

    orderRetentionDays: z.number().int().min(30).max(2_555),

    notifyEmail: z.email().max(255).nullable(),
    notifyOnNewOrder: z.boolean(),
    notifyOnHighRisk: z.boolean(),
    notifyOnSyncFailure: z.boolean(),
    customerEmailEnabled: z.boolean(),
  })
  .partial();

const ButtonSchema = z.object({
  // The one required field: it identifies which of the six rows to write.
  placement: z.enum([
    'PRODUCT_PAGE',
    'CART_PAGE',
    'COLLECTION_PAGE',
    'HOME_PAGE',
    'STICKY_MOBILE',
    'FLOATING',
  ]),
  isEnabled: z.boolean().optional(),
  label: z.string().trim().min(1).max(60).optional(),
  subLabel: z.string().trim().max(60).nullish(),
  iconName: z.string().trim().max(40).nullish(),
  translations: z.record(z.string(), z.unknown()).optional(),
  bgColor: hexColor.optional(),
  textColor: hexColor.optional(),
  borderColor: hexColor.optional(),
  borderRadius: z.number().int().min(0).max(60).optional(),
  fontSize: z.number().int().min(8).max(40).optional(),
  fontWeight: z.string().max(10).optional(),
  paddingY: z.number().int().min(0).max(60).optional(),
  paddingX: z.number().int().min(0).max(80).optional(),
  fullWidth: z.boolean().optional(),
  customCss: z.string().max(5_000).nullish(),
  stickyOffsetBottom: z.number().int().min(0).max(400).optional(),
  floatingPosition: z.string().max(30).optional(),
  showOnMobile: z.boolean().optional(),
  showOnDesktop: z.boolean().optional(),
  showAfterScrollPx: z.number().int().min(0).max(10_000).optional(),
  openInPopup: z.boolean().optional(),
  animation: z.string().max(20).optional(),
});

const FormFieldSchema = z.object({
  key: z.string().trim().min(1).max(60),
  type: z.string().max(30),
  label: z.string().trim().max(120),
  placeholder: z.string().max(120).nullish(),
  helpText: z.string().max(300).nullish(),
  position: z.number().int().min(0).max(10_000),
  isRequired: z.boolean().optional(),
  isEnabled: z.boolean().optional(),
  isSystem: z.boolean().optional(),
  defaultValue: z.string().max(500).nullish(),
  isHidden: z.boolean().optional(),
  minLength: z.number().int().min(0).max(10_000).nullish(),
  maxLength: z.number().int().min(0).max(10_000).nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
  regexPattern: z.string().max(300).nullish(),
  validationMessage: z.string().max(300).nullish(),
  options: z.unknown().optional(),
  conditionalOn: z.unknown().optional(),
  columnWidth: z.number().int().min(1).max(12).optional(),
  cssClass: z.string().max(120).nullish(),
  translations: z.record(z.string(), z.unknown()).optional(),
});

const FormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  headingText: z.string().trim().max(200).optional(),
  subheadingText: z.string().max(300).nullish(),
  submitButtonText: z.string().trim().max(60).optional(),
  successMessage: z.string().max(500).optional(),
  translations: z.record(z.string(), z.unknown()).optional(),
  layout: z.string().max(30).optional(),
  showOrderSummary: z.boolean().optional(),
  showProductImage: z.boolean().optional(),
  showQuantitySelector: z.boolean().optional(),
  showVariantSelector: z.boolean().optional(),
  showCouponField: z.boolean().optional(),
  showTermsCheckbox: z.boolean().optional(),
  termsUrl: httpsUrl.nullish(),
  requireOtp: z.boolean().optional(),
  trackAbandonment: z.boolean().optional(),
  abandonmentDelaySeconds: z.number().int().min(0).max(3_600).optional(),
  botProtection: z.boolean().optional(),
  minFillSeconds: z.number().int().min(0).max(30).optional(),
  fields: z.array(FormFieldSchema).max(60).optional(),
});

const riskAction = z.enum(['ALLOW', 'REVIEW', 'CHALLENGE_OTP', 'BLOCK']);

const FraudSchema = z
  .object({
    isEnabled: z.boolean(),
    mediumThreshold: z.number().int().min(0).max(100),
    highThreshold: z.number().int().min(0).max(100),
    criticalThreshold: z.number().int().min(0).max(100),
    actionOnMedium: riskAction,
    actionOnHigh: riskAction,
    actionOnCritical: riskAction,
    checkDuplicatePhone: z.boolean(),
    checkDuplicateEmail: z.boolean(),
    checkDuplicateAddress: z.boolean(),
    checkDisposableEmail: z.boolean(),
    checkFakePhone: z.boolean(),
    checkVpn: z.boolean(),
    checkProxy: z.boolean(),
    checkTor: z.boolean(),
    checkVelocity: z.boolean(),
    checkCountryRisk: z.boolean(),
    checkIpReputation: z.boolean(),
    checkBlockList: z.boolean(),
    checkDeviceVelocity: z.boolean(),
    maxOrdersPerDayPerPhone: z.number().int().min(0).max(1_000),
    maxOrdersPerDayPerIp: z.number().int().min(0).max(1_000),
    maxOrdersPerDayPerEmail: z.number().int().min(0).max(1_000),
    maxOrdersPerDayPerDevice: z.number().int().min(0).max(1_000),
    maxOpenCodOrders: z.number().int().min(0).max(1_000),
    maxItemsPerOrder: z.number().int().min(0).max(10_000),
    velocityWindowMinutes: z.number().int().min(1).max(10_080),
    velocityMaxOrders: z.number().int().min(0).max(1_000),
    duplicateWindowHours: z.number().int().min(1).max(8_760),
    highRiskCountryCodes: z.array(country).max(250),
    /**
     * The provider name travels; its API key does not. A restored shop points
     * at the same provider and needs the key entered again — which is the
     * correct outcome for a credential that was encrypted at rest.
     */
    ipIntelProvider: z.string().max(40).nullable(),
    blockedMessage: z.string().max(300).nullable(),
    autoBlacklistAfterFailures: z.number().int().min(0).max(100),
    tagHighRiskOrders: z.boolean(),
    highRiskTag: z.string().max(60),
  })
  .partial();

const FraudRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isEnabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  conditions: z.unknown(),
  scoreDelta: z.number().int().min(-1_000).max(1_000).optional(),
  action: riskAction.nullish(),
  reason: z.string().max(300).nullish(),
});

/**
 * A settings file.
 *
 * `shopDomain` is accepted and echoed back so the merchant can see where the
 * file came from, and is never applied — the shop written to is always the
 * authenticated one. Import ignores `exportedAt` entirely.
 */
export const ImportSettingsSchema = z.object({
  version: z.number().int(),
  exportedAt: z.string().max(40).optional(),
  shopDomain: z.string().max(255).optional(),

  settings: SettingsSchema.optional(),
  buttons: z.array(ButtonSchema).max(6).optional(),
  forms: z.array(FormSchema).max(20).optional(),
  fraud: FraudSchema.nullish(),
  fraudRules: z.array(FraudRuleSchema).max(100).optional(),
});

export type ImportSettingsInput = z.infer<typeof ImportSettingsSchema>;

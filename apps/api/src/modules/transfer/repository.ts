import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

/**
 * Settings transfer persistence.
 *
 * Every read here selects columns explicitly, and that is a security decision
 * rather than a style one. `select` is an allow-list: a column added in a later
 * phase — an API key, a token, a shopper's phone number — is absent from the
 * export until somebody names it here. The alternative, fetching whole rows and
 * deleting the sensitive keys afterwards, is a deny-list, and a deny-list is
 * only correct until the next migration.
 */

/** Columns a settings file carries. Ids, timestamps and `shopId` never travel. */
const SETTINGS_FIELDS = {
  codEnabled: true,
  replaceAddToCart: true,
  replaceBuyNow: true,
  enabledOnAllProducts: true,
  includedProductGids: true,
  excludedProductGids: true,
  includedCollectionGids: true,
  codFeeEnabled: true,
  codFeeAmount: true,
  codFeeIsPercent: true,
  minOrderValue: true,
  maxOrderValue: true,
  freeShippingAbove: true,
  shippingFee: true,
  defaultOrderTags: true,
  createAsDraftOrder: true,
  autoFulfill: true,
  markAsPaid: true,
  inventoryBehaviour: true,
  sendShopifyOrderConfirmation: true,
  brandPrimaryColor: true,
  brandSecondaryColor: true,
  brandTextColor: true,
  brandFontFamily: true,
  brandBorderRadius: true,
  brandLogoUrl: true,
  brandLogoHeight: true,
  brandLogoAlignment: true,
  customCss: true,
  themeMode: true,
  defaultLocale: true,
  enabledLocales: true,
  forceRtl: true,
  currencyFormat: true,
  dateFormat: true,
  allowedCountryCodes: true,
  blockedCountryCodes: true,
  allowedPostalPatterns: true,
  blockedPostalPatterns: true,
  orderRetentionDays: true,
  notifyEmail: true,
  notifyOnNewOrder: true,
  notifyOnHighRisk: true,
  notifyOnSyncFailure: true,
  customerEmailEnabled: true,
} as const;

const BUTTON_FIELDS = {
  placement: true,
  isEnabled: true,
  label: true,
  subLabel: true,
  iconName: true,
  translations: true,
  bgColor: true,
  textColor: true,
  borderColor: true,
  borderRadius: true,
  fontSize: true,
  fontWeight: true,
  paddingY: true,
  paddingX: true,
  fullWidth: true,
  customCss: true,
  stickyOffsetBottom: true,
  floatingPosition: true,
  showOnMobile: true,
  showOnDesktop: true,
  showAfterScrollPx: true,
  openInPopup: true,
  animation: true,
} as const;

const FORM_FIELD_FIELDS = {
  key: true,
  type: true,
  label: true,
  placeholder: true,
  helpText: true,
  position: true,
  isRequired: true,
  isEnabled: true,
  isSystem: true,
  defaultValue: true,
  isHidden: true,
  minLength: true,
  maxLength: true,
  minValue: true,
  maxValue: true,
  regexPattern: true,
  validationMessage: true,
  options: true,
  conditionalOn: true,
  columnWidth: true,
  cssClass: true,
  translations: true,
} as const;

/**
 * Fraud configuration, minus `ipIntelApiKeyEnc`.
 *
 * The provider name travels so a restored shop points at the same service; the
 * key does not, because it is encrypted at rest for exactly the reason a
 * downloadable file is the wrong place for it.
 */
const FRAUD_FIELDS = {
  isEnabled: true,
  mediumThreshold: true,
  highThreshold: true,
  criticalThreshold: true,
  actionOnMedium: true,
  actionOnHigh: true,
  actionOnCritical: true,
  checkDuplicatePhone: true,
  checkDuplicateEmail: true,
  checkDuplicateAddress: true,
  checkDisposableEmail: true,
  checkFakePhone: true,
  checkVpn: true,
  checkProxy: true,
  checkTor: true,
  checkVelocity: true,
  checkCountryRisk: true,
  checkIpReputation: true,
  checkBlockList: true,
  checkDeviceVelocity: true,
  maxOrdersPerDayPerPhone: true,
  maxOrdersPerDayPerIp: true,
  maxOrdersPerDayPerEmail: true,
  maxOrdersPerDayPerDevice: true,
  maxOpenCodOrders: true,
  maxItemsPerOrder: true,
  velocityWindowMinutes: true,
  velocityMaxOrders: true,
  duplicateWindowHours: true,
  highRiskCountryCodes: true,
  ipIntelProvider: true,
  blockedMessage: true,
  autoBlacklistAfterFailures: true,
  tagHighRiskOrders: true,
  highRiskTag: true,
} as const;

/** Merchant-authored rules. Match counters are history, not configuration. */
const FRAUD_RULE_FIELDS = {
  name: true,
  isEnabled: true,
  priority: true,
  conditions: true,
  scoreDelta: true,
  action: true,
  reason: true,
} as const;

export function findSettings(shopId: string) {
  return prisma.shopSettings.findUnique({ where: { shopId }, select: SETTINGS_FIELDS });
}

export function findButtons(shopId: string) {
  return prisma.buttonConfig.findMany({
    where: { shopId },
    select: BUTTON_FIELDS,
    orderBy: { placement: 'asc' },
  });
}

export function findForms(shopId: string) {
  return prisma.formConfig.findMany({
    where: { shopId },
    select: {
      name: true,
      isActive: true,
      isDefault: true,
      headingText: true,
      subheadingText: true,
      submitButtonText: true,
      successMessage: true,
      translations: true,
      layout: true,
      showOrderSummary: true,
      showProductImage: true,
      showQuantitySelector: true,
      showVariantSelector: true,
      showCouponField: true,
      showTermsCheckbox: true,
      termsUrl: true,
      requireOtp: true,
      trackAbandonment: true,
      abandonmentDelaySeconds: true,
      botProtection: true,
      minFillSeconds: true,
      fields: { select: FORM_FIELD_FIELDS, orderBy: { position: 'asc' } },
    },
    orderBy: { name: 'asc' },
  });
}

export function findFraud(shopId: string) {
  return prisma.fraudSettings.findUnique({ where: { shopId }, select: FRAUD_FIELDS });
}

export function findFraudRules(shopId: string) {
  return prisma.fraudRule.findMany({
    where: { shopId },
    select: FRAUD_RULE_FIELDS,
    orderBy: { priority: 'asc' },
  });
}

export function updateSettings(shopId: string, data: Prisma.ShopSettingsUpdateInput) {
  return prisma.shopSettings.update({ where: { shopId }, data, select: { shopId: true } });
}

export function upsertButton(
  shopId: string,
  placement: string,
  data: Prisma.ButtonConfigUncheckedUpdateInput,
) {
  return prisma.buttonConfig.upsert({
    where: { shopId_placement: { shopId, placement: placement as never } },
    update: data,
    // The whole merged record on create, for the reason `buttons/service`
    // writes it too: the create branch would otherwise take the column
    // defaults and switch a placement on that the file left off.
    create: { ...(data as object), shopId, placement } as never,
    select: { placement: true },
  });
}

export function upsertFraudSettings(shopId: string, data: Prisma.FraudSettingsUncheckedUpdateInput) {
  return prisma.fraudSettings.upsert({
    where: { shopId },
    update: data,
    create: { ...(data as object), shopId } as never,
    select: { shopId: true },
  });
}

/**
 * Replaces a shop's rules with the file's.
 *
 * Merging by name would leave a rule the merchant deleted before exporting
 * still active after importing, which is the opposite of restoring a backup.
 * One transaction, so a failure part-way cannot leave a shop with no rules.
 */
export function replaceFraudRules(shopId: string, rules: Prisma.FraudRuleCreateManyInput[]) {
  return prisma.$transaction(async (tx) => {
    await tx.fraudRule.deleteMany({ where: { shopId } });
    if (rules.length === 0) return 0;

    const created = await tx.fraudRule.createMany({ data: rules });
    return created.count;
  });
}

/** Replaces one form's fields. Same reasoning as the rules above. */
export function replaceFormFields(
  shopId: string,
  formName: string,
  form: Prisma.FormConfigUncheckedUpdateInput,
  fields: Omit<Prisma.FormFieldCreateManyInput, 'formConfigId'>[],
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.formConfig.findFirst({
      where: { shopId, name: formName },
      select: { id: true },
    });

    const row = existing
      ? await tx.formConfig.update({
          where: { id: existing.id },
          data: form,
          select: { id: true },
        })
      : await tx.formConfig.create({
          data: { ...(form as object), shopId, name: formName } as never,
          select: { id: true },
        });

    if (fields.length > 0) {
      await tx.formField.deleteMany({ where: { formConfigId: row.id } });
      await tx.formField.createMany({
        data: fields.map((field) => ({ ...field, formConfigId: row.id })),
      });
    }

    return row.id;
  });
}

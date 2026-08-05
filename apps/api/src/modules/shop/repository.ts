import { type Locale, OtpProvider, Plan, type Prisma, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { createLogger } from '../../lib/logger';
import { EXEMPT_PLAN, hasPlanExemptions, isPlanExempt } from '../../lib/planExemption';
import {
  DEFAULT_BUTTON_CONFIGS,
  DEFAULT_FORM_CONFIG,
  DEFAULT_FORM_FIELDS,
  DEFAULT_NOTIFICATION_TEMPLATES,
  FIELD_POSITION_STEP,
} from './defaults';

const log = createLogger('shop-repository');

/**
 * Shop persistence. The only layer in this module that touches Prisma.
 *
 * `Shop` is the tenant root, so provisioning is the most consequential write in
 * the app: everything downstream assumes a shop row exists together with its
 * settings, subscription, default form and default buttons. Creating them
 * piecemeal would leave a half-provisioned tenant behind on any failure, which
 * is why the whole set goes in one transaction.
 */

/** Shop plus the relations `/api/admin/session` needs, fetched in one round trip. */
export type ShopWithContext = Prisma.ShopGetPayload<{
  include: { settings: true; subscription: true };
}>;

export function findByDomain(domain: string): Promise<ShopWithContext | null> {
  return prisma.shop.findUnique({
    where: { domain },
    include: { settings: true, subscription: true },
  });
}

export function findIdByDomain(domain: string): Promise<{ id: string } | null> {
  return prisma.shop.findUnique({ where: { domain }, select: { id: true } });
}

/** The three fields every analytics bucket depends on. */
export interface ShopAnalyticsContext {
  readonly id: string;
  readonly timezone: string;
  readonly ianaTimezone: string | null;
  readonly currencyCode: string;
}

/**
 * Timezone and currency for a shop, by id.
 *
 * Its own query rather than a `findByDomain` because it runs on the hot path —
 * once per recorded order, sync and pixel batch — and pulling the settings and
 * subscription relations along for four columns would be three joins for
 * nothing.
 */
export function findAnalyticsContext(shopId: string): Promise<ShopAnalyticsContext | null> {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, timezone: true, ianaTimezone: true, currencyCode: true },
  });
}

/**
 * Creates a shop and its default records, or revives an existing one.
 *
 * Reinstall is the case that dictates the shape here. When a merchant
 * uninstalls, the row is *not* deleted — their forms, blacklist and order
 * history are kept, because reinstalling and finding an empty app is the single
 * most common complaint about COD apps. So this must distinguish three states:
 *
 *   - no row            -> create everything
 *   - row, uninstalled  -> clear `uninstalledAt`, keep all configuration
 *   - row, active       -> refresh scopes only
 *
 * Idempotent: safe to call on every authenticated request, which is exactly how
 * the auth middleware uses it.
 */
export async function ensureProvisioned(
  domain: string,
  grantedScopes: string | null,
): Promise<{ shop: ShopWithContext; created: boolean; reinstalled: boolean }> {
  const existing = await findByDomain(domain);

  if (existing) {
    const reinstalled = existing.uninstalledAt !== null || !existing.isActive;
    const scopesChanged = grantedScopes !== null && existing.grantedScopes !== grantedScopes;

    if (!reinstalled && !scopesChanged) {
      return { shop: existing, created: false, reinstalled: false };
    }

    const shop = await prisma.shop.update({
      where: { id: existing.id },
      data: {
        ...(reinstalled ? { uninstalledAt: null, isActive: true, installedAt: new Date() } : {}),
        ...(grantedScopes !== null ? { grantedScopes } : {}),
      },
      include: { settings: true, subscription: true },
    });

    if (reinstalled) {
      log.info({ shop: domain }, 'Shop reinstalled — existing configuration preserved');
      // A reinstall after a long gap can find defaults missing because a later
      // migration added a model. Backfilling keeps the invariant that every
      // active shop has a complete default set.
      await backfillDefaults(shop.id);
      return {
        shop: (await findByDomain(domain)) ?? shop,
        created: false,
        reinstalled: true,
      };
    }

    return { shop, created: false, reinstalled: false };
  }

  await createWithDefaults(domain, grantedScopes);

  const shop = await findByDomain(domain);
  if (!shop) {
    // Only reachable if another process deleted the row between the write and
    // this read, which in practice means a concurrent shop/redact.
    throw new Error(`Shop ${domain} disappeared immediately after provisioning`);
  }

  log.info({ shop: domain }, 'Shop provisioned');
  return { shop, created: true, reinstalled: false };
}

/**
 * The install transaction.
 *
 * Nested writes rather than sequential calls so Postgres does the whole thing
 * atomically. The `onConflict`-style guard is the outer unique constraint on
 * `Shop.domain`: two simultaneous first requests race here, one wins, and the
 * loser's P2002 is absorbed by the caller re-reading the row.
 */
async function createWithDefaults(domain: string, grantedScopes: string | null): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const shop = await tx.shop.create({
        data: {
          domain,
          grantedScopes,
          isActive: true,
          settings: { create: {} },
          subscription: {
            create: {
              plan: Plan.FREE,
              status: SubscriptionStatus.ACTIVE,
              activatedAt: new Date(),
            },
          },
          fraudSettings: { create: { isEnabled: true } },
          otpSettings: { create: { isEnabled: false, provider: OtpProvider.MSG91 } },
          formConfigs: {
            create: {
              ...DEFAULT_FORM_CONFIG,
              fields: {
                create: DEFAULT_FORM_FIELDS.map((field, index) => ({
                  ...field,
                  position: index * FIELD_POSITION_STEP,
                })),
              },
            },
          },
          buttonConfigs: { create: DEFAULT_BUTTON_CONFIGS.map((button) => ({ ...button })) },
          notificationTemplates: {
            create: DEFAULT_NOTIFICATION_TEMPLATES.map((template) => ({ ...template })),
          },
        },
        select: { id: true },
      });

      log.debug({ shop: domain, shopId: shop.id }, 'Default records created');
    });
  } catch (error) {
    // Lost the race against a concurrent install. The winner created an
    // identical row, so there is nothing to repair.
    if ((error as { code?: string }).code === 'P2002') {
      log.debug({ shop: domain }, 'Concurrent provisioning detected, using the existing row');
      return;
    }
    throw error;
  }
}

/**
 * Adds any default record a shop is missing, without touching what it has.
 *
 * Used on reinstall and after schema additions. Every write is an upsert keyed
 * on a natural unique constraint, so a merchant's customized form survives.
 */
export async function backfillDefaults(shopId: string): Promise<void> {
  await prisma.shopSettings.upsert({
    where: { shopId },
    update: {},
    create: { shopId },
  });

  await prisma.subscription.upsert({
    where: { shopId },
    update: {},
    create: {
      shopId,
      plan: Plan.FREE,
      status: SubscriptionStatus.ACTIVE,
      activatedAt: new Date(),
    },
  });

  await prisma.fraudSettings.upsert({
    where: { shopId },
    update: {},
    create: { shopId, isEnabled: true },
  });

  await prisma.otpSettings.upsert({
    where: { shopId },
    update: {},
    create: { shopId, isEnabled: false, provider: OtpProvider.MSG91 },
  });

  const formConfig = await prisma.formConfig.upsert({
    where: { shopId_name: { shopId, name: DEFAULT_FORM_CONFIG.name } },
    update: {},
    create: { shopId, ...DEFAULT_FORM_CONFIG },
    select: { id: true },
  });

  for (const [index, field] of DEFAULT_FORM_FIELDS.entries()) {
    await prisma.formField.upsert({
      where: { formConfigId_key: { formConfigId: formConfig.id, key: field.key } },
      update: {},
      create: { formConfigId: formConfig.id, ...field, position: index * FIELD_POSITION_STEP },
    });
  }

  for (const button of DEFAULT_BUTTON_CONFIGS) {
    await prisma.buttonConfig.upsert({
      where: { shopId_placement: { shopId, placement: button.placement } },
      update: {},
      create: { shopId, ...button },
    });
  }

  for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: {
        shopId_key_channel: { shopId, key: template.key, channel: template.channel },
      },
      update: {},
      create: { shopId, ...template },
    });
  }
}

export interface ShopMetadataUpdate {
  shopifyGid?: string;
  name?: string;
  email?: string;
  ownerName?: string;
  phone?: string;
  countryCode?: string;
  currencyCode?: string;
  primaryLocale?: string;
  timezone?: string;
  ianaTimezone?: string;
  planDisplayName?: string;
  shopifyPlan?: string;
}

/**
 * Refreshes cached shop facts from the Admin API.
 *
 * Currency and timezone are the two that matter operationally: analytics
 * bucket orders by the shop's local midnight, and every amount rendered in the
 * admin is formatted with the shop's currency. A stale value there produces
 * numbers that are wrong rather than merely old.
 */
export function updateMetadata(shopId: string, data: ShopMetadataUpdate): Promise<{ id: string }> {
  return prisma.shop.update({ where: { id: shopId }, data, select: { id: true } });
}

export function updateGrantedScopes(shopId: string, grantedScopes: string): Promise<{ id: string }> {
  return prisma.shop.update({ where: { id: shopId }, data: { grantedScopes }, select: { id: true } });
}

/**
 * Marks a shop uninstalled without deleting anything.
 *
 * Retaining the data is a deliberate trade. Shopify only guarantees that a
 * merchant's data be removed on `shop/redact`, which arrives 48 hours after
 * uninstall — until then, a merchant who uninstalls and reinstalls the same day
 * (which is common while they evaluate apps) gets their configuration back.
 */
export async function markUninstalled(domain: string): Promise<string | null> {
  const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true } });
  if (!shop) return null;

  await prisma.shop.update({
    where: { id: shop.id },
    data: { isActive: false, uninstalledAt: new Date() },
  });

  return shop.id;
}

/**
 * Hard delete for `shop/redact`.
 *
 * Every model carries `onDelete: Cascade` from `Shop`, so removing the root row
 * removes orders, risk assessments, OTP records and audit logs in one statement.
 * That cascade is the reason the schema insists on `shopId` everywhere.
 */
export async function purge(domain: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true } });
  if (!shop) return false;

  await prisma.shop.delete({ where: { id: shop.id } });
  log.warn({ shop: domain }, 'Shop purged in response to shop/redact');
  return true;
}

/**
 * The columns that make a COD order personal, and what they become.
 *
 * Shared by the two paths that clear them — a shopper's redaction request and
 * the retention sweep — because they must agree. A field added to one and not
 * the other is a field that survives a redaction, which is the failure nobody
 * notices until a regulator does.
 *
 * Everything absent from this list is deliberately kept: totals, timestamps and
 * product ids are not personal data, and they are exactly what the merchant's
 * analytics reads.
 */
const REDACTION: Prisma.CodOrderUpdateManyMutationInput = {
  firstName: null,
  lastName: null,
  email: null,
  // `phone` is non-nullable — it is the one field a COD order cannot exist
  // without — so it is overwritten with a tombstone rather than cleared.
  phone: '[redacted]',
  phoneE164: null,
  address1: null,
  address2: null,
  city: null,
  province: null,
  postalCode: null,
  addressHash: null,
  ipAddress: null,
  userAgent: null,
  deviceFingerprint: null,
  orderNotes: null,
  customFields: {},
};

/**
 * Removes the personal data of one customer across every COD order.
 *
 * Answering `customers/redact` by deleting the orders would destroy the
 * merchant's revenue history, so the rows survive with their identifying
 * columns blanked. What remains — totals, timestamps, product ids — is not
 * personal data and is what analytics actually reads.
 */
export async function redactCustomer(
  domain: string,
  identifiers: { email?: string | null; phone?: string | null; shopifyCustomerGid?: string | null },
): Promise<number> {
  const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true } });
  if (!shop) return 0;

  const matchers: Prisma.CodOrderWhereInput[] = [];
  if (identifiers.email) matchers.push({ email: identifiers.email });
  if (identifiers.phone) {
    matchers.push({ phone: identifiers.phone }, { phoneE164: identifiers.phone });
  }
  if (identifiers.shopifyCustomerGid) {
    matchers.push({ shopifyCustomerGid: identifiers.shopifyCustomerGid });
  }

  if (matchers.length === 0) return 0;

  const result = await prisma.codOrder.updateMany({
    where: { shopId: shop.id, OR: matchers },
    data: { ...REDACTION, redactedAt: new Date() },
  });

  log.warn({ shop: domain, orders: result.count }, 'Customer data redacted');
  return result.count;
}

/**
 * Clears personal data from orders that have outlived their shop's retention
 * period. The enforcement half of `ShopSettings.orderRetentionDays`.
 *
 * Blanking rather than deleting, for the same reason `redactCustomer` does: a
 * merchant's revenue history must not change because a retention period
 * elapsed. Only the personal columns go.
 *
 * Bounded per call. A shop switched on after two years of orders has a large
 * first sweep, and one unbounded `updateMany` would hold write locks across
 * every one of those rows while the shopper-facing submission path waits behind
 * it. The caller re-runs until this returns zero.
 *
 * `redactedAt: null` is what makes the sweep cheap on every night after the
 * first — without it this would re-examine and re-blank the shop's entire
 * history daily.
 */
export async function anonymiseExpiredOrders(
  shopId: string,
  cutoff: Date,
  limit = 500,
): Promise<number> {
  const expired = await prisma.codOrder.findMany({
    where: { shopId, redactedAt: null, createdAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  if (expired.length === 0) return 0;

  const result = await prisma.codOrder.updateMany({
    where: { id: { in: expired.map((order) => order.id) } },
    data: { ...REDACTION, redactedAt: new Date() },
  });

  return result.count;
}

/** Shops with at least one order past their retention period. */
export function findShopsForRetentionSweep(): Promise<
  { id: string; domain: string; settings: { orderRetentionDays: number } | null }[]
> {
  return prisma.shop.findMany({
    // Uninstalled shops are excluded on purpose: `shop/redact` deletes them
    // outright 48 hours later, which is a stronger guarantee than this sweep.
    where: { isActive: true },
    select: { id: true, domain: true, settings: { select: { orderRetentionDays: true } } },
  });
}

/**
 * Everything the app holds about one customer, for `customers/data_request`.
 *
 * Shopify forwards a shopper's data request to every installed app and gives
 * the app 30 days to hand the merchant what it stores. Selecting explicit
 * columns rather than whole rows keeps that answer to data about *this person*
 * — a COD order also carries merchant-side fields (internal notes, risk
 * signals, sync state) that are not the shopper's personal data and would leak
 * the merchant's own operations into a customer-facing export.
 */
export async function collectCustomerData(
  domain: string,
  identifiers: { email?: string | null; phone?: string | null; shopifyCustomerGid?: string | null },
) {
  const shop = await prisma.shop.findUnique({ where: { domain }, select: { id: true } });
  if (!shop) return null;

  const matchers: Prisma.CodOrderWhereInput[] = [];
  if (identifiers.email) matchers.push({ email: identifiers.email });
  if (identifiers.phone) {
    matchers.push({ phone: identifiers.phone }, { phoneE164: identifiers.phone });
  }
  if (identifiers.shopifyCustomerGid) {
    matchers.push({ shopifyCustomerGid: identifiers.shopifyCustomerGid });
  }

  if (matchers.length === 0) return { shopId: shop.id, orders: [] };

  const orders = await prisma.codOrder.findMany({
    where: { shopId: shop.id, OR: matchers },
    orderBy: { createdAt: 'desc' },
    select: {
      reference: true,
      status: true,
      createdAt: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      address1: true,
      address2: true,
      city: true,
      province: true,
      country: true,
      postalCode: true,
      orderNotes: true,
      lineItems: true,
      currency: true,
      total: true,
      customFields: true,
      ipAddress: true,
      userAgent: true,
      marketingConsent: true,
      shopifyOrderNumber: true,
    },
  });

  return { shopId: shop.id, orders };
}

/**
 * Adopts the storefront's languages as the COD form's languages.
 *
 * Only touches `ShopSettings`, and only the two locale columns — a merchant who
 * has already curated this list keeps their choice on every subsequent sync,
 * because this is called once at install rather than on a schedule.
 */
/** The visibility columns, and only those. */
/**
 * The COD fee and shipping columns.
 *
 * One constant for both reads, so a field added to the screen cannot be
 * returned by the fetch and silently dropped by the save.
 */
const FEE_FIELDS = {
  codFeeEnabled: true,
  codFeeAmount: true,
  codFeeIsPercent: true,
  shippingFee: true,
  freeShippingAbove: true,
} as const;

export function findFees(shopId: string) {
  return prisma.shopSettings.findUnique({ where: { shopId }, select: FEE_FIELDS });
}

export function updateFees(shopId: string, data: Prisma.ShopSettingsUpdateInput) {
  return prisma.shopSettings.update({ where: { shopId }, data, select: FEE_FIELDS });
}

export function findVisibility(shopId: string) {
  return prisma.shopSettings.findUnique({
    where: { shopId },
    select: {
      codEnabled: true,
      replaceAddToCart: true,
      replaceBuyNow: true,
      enabledOnAllProducts: true,
      includedProductGids: true,
      excludedProductGids: true,
      includedCollectionGids: true,
      allowedCountryCodes: true,
      blockedCountryCodes: true,
      allowedPostalPatterns: true,
      blockedPostalPatterns: true,
      minOrderValue: true,
      maxOrderValue: true,
    },
  });
}

export function updateVisibility(shopId: string, data: Prisma.ShopSettingsUpdateInput) {
  return prisma.shopSettings.update({
    where: { shopId },
    data,
    select: {
      codEnabled: true,
      replaceAddToCart: true,
      replaceBuyNow: true,
      enabledOnAllProducts: true,
      includedProductGids: true,
      excludedProductGids: true,
      includedCollectionGids: true,
      allowedCountryCodes: true,
      blockedCountryCodes: true,
      allowedPostalPatterns: true,
      blockedPostalPatterns: true,
      minOrderValue: true,
      maxOrderValue: true,
    },
  });
}

/** The branding columns, and only those. */
export function findBranding(shopId: string) {
  return prisma.shopSettings.findUnique({
    where: { shopId },
    select: {
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
    },
  });
}

export function updateBranding(shopId: string, data: Prisma.ShopSettingsUpdateInput) {
  return prisma.shopSettings.update({
    where: { shopId },
    data,
    select: {
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
    },
  });
}

export async function updateLocalePreferences(
  shopId: string,
  enabledLocales: Locale[],
  defaultLocale: Locale | null,
): Promise<void> {
  await prisma.shopSettings.update({
    where: { shopId },
    data: {
      enabledLocales,
      ...(defaultLocale ? { defaultLocale } : {}),
    },
  });
}

/**
 * The plan a shop's entitlements are computed from.
 *
 * Read per request rather than cached on the session, so a merchant who
 * upgrades mid-session can use what they just paid for without signing out.
 * Defaults to FREE when no subscription row exists — the safe reading, since
 * every limit is then at its tightest.
 *
 * **Status matters as much as the plan.** A `FROZEN` subscription — Shopify's
 * state when a merchant's own Shopify invoice is unpaid — resolves to FREE,
 * because they are not currently paying for what it grants. Same for `EXPIRED`
 * and `CANCELLED`. The row keeps its real plan so the UI can say "your Pro plan
 * is paused" instead of pretending they were never a customer, and nothing they
 * configured is deleted; only the entitlement lapses.
 *
 * Every entitlement decision in the app resolves through here or through
 * `billing/service.effectivePlan`, which applies the identical rule. Two places
 * disagreeing about what a frozen shop may do is precisely the bug this
 * comment exists to prevent.
 */
export async function findPlan(shopId: string): Promise<Plan> {
  const subscription = await prisma.subscription.findUnique({
    where: { shopId },
    // The shop's domain rides along so the exemption can be applied without a
    // second query — and so it is applied even when there is no subscription.
    select: { plan: true, status: true, shop: { select: { domain: true } } },
  });

  if (hasPlanExemptions()) {
    const domain = subscription?.shop.domain
      ?? (await prisma.shop.findUnique({ where: { id: shopId }, select: { domain: true } }))?.domain;

    if (isPlanExempt(domain)) return EXEMPT_PLAN;
  }

  if (!subscription) return Plan.FREE;

  const entitled =
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.TRIALING;

  return entitled ? subscription.plan : Plan.FREE;
}

/**
 * Where merchant-facing mail goes.
 *
 * Prefers the address the merchant explicitly set for notifications over the
 * shop's own contact email, because on many stores the latter is a customer
 * service inbox that nobody watches for operational alerts.
 */
export async function findNotificationEmail(shopId: string): Promise<string | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { email: true, settings: { select: { notifyEmail: true } } },
  });

  return shop?.settings?.notifyEmail ?? shop?.email ?? null;
}

/** Advances the onboarding checklist. */
export function updateOnboarding(
  shopId: string,
  step: number,
  completed: boolean,
): Promise<{ id: string }> {
  return prisma.shop.update({
    where: { id: shopId },
    data: {
      onboardingStep: step,
      onboardingCompletedAt: completed ? new Date() : null,
    },
    select: { id: true },
  });
}

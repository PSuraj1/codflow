import type { Session } from '@shopify/shopify-api';
import type {
  Locale,
  OnboardingState,
  ScopeState,
  SessionResponse,
  ShopBrandingSummary,
  ShopFeesSummary,
  ShopVisibilitySummary,
  ShopIdentity,
  SubscriptionSummary,
  ThemeMode,
  UiPreferences,
} from '@codflow/shared';
import { Locale as LocaleEnum, Plan, SubscriptionStatus } from '@codflow/shared';
import type { AdminAuthContext } from '../../types/express';
import { config } from '../../config/env';
import { createLogger } from '../../lib/logger';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { invalidateTag, shopTag } from '../../lib/cache';
import { withPlanExemption } from '../../lib/planExemption';
import { assertFeature } from '../billing/limits';
import { tryAdminGraphql } from '../../shopify/graphql';
import {
  SHOP_INFO_QUERY,
  SHOP_LOCALES_QUERY,
  type ShopInfoResponse,
  type ShopLocalesResponse,
} from '../../shopify/queries/shop';
import * as billingService from '../billing/service';
import * as authService from '../auth/service';
import * as repository from './repository';
import type { ShopWithContext } from './repository';
import type { UpdateBrandingInput, UpdateFeesInput, UpdateVisibilityInput } from './dto';

const log = createLogger('shop-service');

/**
 * Shop-level orchestration.
 *
 * The one endpoint this serves — `GET /api/admin/session` — is called by the
 * admin immediately after App Bridge boots, and its job is to answer everything
 * the shell needs in a single round trip. Splitting it into "get shop", "get
 * plan", "get scopes" would put three sequential requests in front of the first
 * paint of an app that already loads inside someone else's iframe.
 */

/**
 * Fills in shop facts from the Admin API.
 *
 * Called on first install and whenever the cached copy is obviously incomplete.
 * Failure is tolerated: a merchant should still get into the app when Shopify
 * is briefly unavailable, and every field here has a usable default.
 */
export async function refreshMetadata(shopId: string, session: Session): Promise<void> {
  const info = await tryAdminGraphql<ShopInfoResponse>(session, SHOP_INFO_QUERY);

  if (!info) {
    log.warn({ shop: session.shop }, 'Could not refresh shop metadata — keeping cached values');
    return;
  }

  const shop = info.shop;

  await repository.updateMetadata(shopId, {
    shopifyGid: shop.id,
    name: shop.name,
    ...(shop.email ?? shop.contactEmail ? { email: (shop.email ?? shop.contactEmail) as string } : {}),
    ...(shop.billingAddress?.countryCodeV2
      ? { countryCode: shop.billingAddress.countryCodeV2 }
      : {}),
    ...(shop.billingAddress?.phone ? { phone: shop.billingAddress.phone } : {}),
    currencyCode: shop.currencyCode,
    ...(shop.ianaTimezone ? { ianaTimezone: shop.ianaTimezone, timezone: shop.ianaTimezone } : {}),
    planDisplayName: shop.plan.displayName,
    // `partnerDevelopment` is how a development store is identified. Billing
    // must never charge one, and analytics should not count its orders as
    // revenue, so it is recorded rather than derived later.
    shopifyPlan: shop.plan.partnerDevelopment
      ? 'partner_test'
      : shop.plan.shopifyPlus
        ? 'shopify_plus'
        : shop.plan.displayName,
  });

  await syncLocales(shopId, session);
}

/**
 * Adopts the storefront's published locales as the COD form's enabled locales.
 *
 * A merchant selling in three languages should not have to discover a language
 * setting to stop their COD form appearing in English only. Restricted to
 * locales CodFlow actually ships translations for — anything else would render
 * a form with untranslated labels, which is worse than English.
 */
async function syncLocales(shopId: string, session: Session): Promise<void> {
  const result = await tryAdminGraphql<ShopLocalesResponse>(session, SHOP_LOCALES_QUERY);
  if (!result) return;

  // Shopify returns BCP 47 tags (`pt-BR`); CodFlow's Locale enum is
  // language-only and uppercase.
  const toLocale = (tag: string): Locale | null => {
    const language = tag.split('-')[0]?.toUpperCase() ?? '';
    return language in LocaleEnum ? (language as Locale) : null;
  };

  const published = result.shopLocales
    .filter((entry) => entry.published)
    .map((entry) => toLocale(entry.locale))
    .filter((locale): locale is Locale => locale !== null);

  const primaryTag = result.shopLocales.find((entry) => entry.primary)?.locale;
  const primary = primaryTag ? toLocale(primaryTag) : null;

  if (primaryTag) {
    await repository.updateMetadata(shopId, {
      primaryLocale: primaryTag.split('-')[0]?.toLowerCase() ?? 'en',
    });
  }

  // Only locales CodFlow ships translations for. Enabling one it does not
  // would render a COD form with untranslated labels, which is worse for a
  // shopper than a form that is consistently in English.
  if (published.length > 0) {
    await repository.updateLocalePreferences(shopId, published, primary ?? published[0] ?? null);
  }

  log.debug({ shop: session.shop, locales: published }, 'Storefront locales adopted');
}

function toShopIdentity(shop: ShopWithContext): ShopIdentity {
  return {
    id: shop.id,
    domain: shop.domain,
    name: shop.name,
    email: shop.email,
    countryCode: shop.countryCode,
    currencyCode: shop.currencyCode,
    primaryLocale: shop.primaryLocale,
    ianaTimezone: shop.ianaTimezone,
    shopifyPlan: shop.shopifyPlan,
    installedAt: shop.installedAt.toISOString(),
    isActive: shop.isActive,
  };
}

/**
 * Subscription view.
 *
 * Defaults to an active FREE plan when no row exists. Provisioning always
 * creates one, so a null here means a shop from before that guarantee — and the
 * right answer for them is the free tier, not an error that locks them out of
 * the app entirely.
 */
function toSubscriptionSummary(shop: ShopWithContext): SubscriptionSummary {
  const subscription = shop.subscription;

  /**
   * The exemption is applied here as well as in `effectivePlan`, and it has to
   * be: the gates read one and the admin renders the other. Without it an
   * exempt shop is gated as Enterprise while its badge says Free — every paid
   * feature works, and the merchant is told to upgrade to reach them.
   */
  if (!subscription) {
    return {
      plan: withPlanExemption(shop.domain, Plan.FREE),
      status: SubscriptionStatus.ACTIVE,
      trialEndsAt: null,
      currentPeriodEnd: null,
      isTest: false,
    };
  }

  return {
    plan: withPlanExemption(shop.domain, subscription.plan as Plan),
    status: subscription.status as SubscriptionStatus,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    isTest: subscription.isTest,
  };
}

function toPreferences(shop: ShopWithContext): UiPreferences {
  const settings = shop.settings;

  return {
    defaultLocale: (settings?.defaultLocale ?? 'EN') as Locale,
    enabledLocales: (settings?.enabledLocales ?? ['EN']) as Locale[],
    themeMode: (settings?.themeMode ?? 'SYSTEM') as ThemeMode,
    brandPrimaryColor: settings?.brandPrimaryColor ?? '#008060',
  };
}

function toOnboarding(shop: ShopWithContext): OnboardingState {
  return {
    completed: shop.onboardingCompletedAt !== null,
    step: shop.onboardingStep,
  };
}

/**
 * Builds the payload for `GET /api/admin/session`.
 *
 * Also the place where a first install gets its metadata: the shop row exists
 * by the time this runs (the auth middleware created it) but carries only a
 * domain, because provisioning deliberately does no network I/O. Filling it in
 * here means the merchant's very first screen shows their store name and
 * currency rather than placeholders.
 */
export async function buildSessionResponse(auth: AdminAuthContext): Promise<SessionResponse> {
  let shop = await repository.findByDomain(auth.shopDomain);

  if (!shop) {
    // The auth middleware provisions before this runs, so the only way here is
    // a concurrent shop/redact between the two.
    throw new Error(`Shop ${auth.shopDomain} vanished between authentication and session build`);
  }

  // `shopifyGid` is only ever set by refreshMetadata, so its absence is an
  // exact marker for "never enriched" — no timestamp comparison needed.
  if (!shop.shopifyGid) {
    await refreshMetadata(shop.id, auth.session);
    shop = (await repository.findByDomain(auth.shopDomain)) ?? shop;
  }

  // Re-verify the plan when the cached answer has aged out. Cheap in the common
  // case — one indexed read of `lastVerifiedAt` and no network call — and this
  // is the backstop that catches a cancellation whose webhook was missed. The
  // shop is re-read afterwards so the response carries the new plan rather than
  // the one this request started with.
  const verified = await billingService.reconcileIfStale(shop.id, auth.shopDomain);

  if (verified && verified.plan !== shop.subscription?.plan) {
    shop = (await repository.findByDomain(auth.shopDomain)) ?? shop;
  }

  const scopes: ScopeState = authService.evaluateScopes(auth.session.scope);

  return {
    shop: toShopIdentity(shop),
    subscription: toSubscriptionSummary(shop),
    onboarding: toOnboarding(shop),
    scopes,
    preferences: toPreferences(shop),
    // The session token carries no locale claim, and the offline session is not
    // tied to a person. The field exists for a future online-token path; until
    // then the admin falls back to the shop's primary locale.
    user: auth.userId ? { id: auth.userId, locale: null } : null,
    apiVersion: config.shopify.apiVersion,
  };
}

/** Records progress through the setup checklist. */
/**
 * Shop branding.
 *
 * The storefront config embeds these values, so every write has to invalidate
 * the shop's cache — otherwise a merchant changes their colour, reloads their
 * storefront, and sees the old one for up to five minutes with nothing to
 * suggest the save worked.
 *
 * Custom CSS is plan-gated the same way the button's is, and for the same
 * reason gated on *change* rather than on presence: a merchant who downgrades
 * keeps their rules — the storefront simply stops serving them — and can still
 * edit their colours without being refused for a field they did not touch.
 */
function toBranding(row: NonNullable<Awaited<ReturnType<typeof repository.findBranding>>>) {
  return {
    primaryColor: row.brandPrimaryColor,
    secondaryColor: row.brandSecondaryColor,
    textColor: row.brandTextColor,
    fontFamily: row.brandFontFamily,
    borderRadius: row.brandBorderRadius,
    logoUrl: row.brandLogoUrl,
    logoHeight: row.brandLogoHeight,
    logoAlignment: row.brandLogoAlignment as ShopBrandingSummary['logoAlignment'],
    customCss: row.customCss,
    themeMode: row.themeMode as ShopBrandingSummary['themeMode'],
  };
}

export async function getBranding(shopId: string): Promise<ShopBrandingSummary> {
  const row = await repository.findBranding(shopId);
  if (!row) throw new NotFoundError('This shop has no settings record');

  return toBranding(row);
}

export async function updateBranding(
  shopId: string,
  shopDomain: string,
  input: UpdateBrandingInput,
): Promise<ShopBrandingSummary> {
  const current = await getBranding(shopId);

  const nextCss =
    input.customCss === undefined
      ? current.customCss
      : (input.customCss?.trim() ?? '') === ''
        ? null
        : input.customCss;

  if (nextCss !== null && nextCss !== current.customCss) {
    await assertFeature(shopId, 'customCss');
  }

  const row = await repository.updateBranding(shopId, {
    ...(input.primaryColor !== undefined ? { brandPrimaryColor: input.primaryColor } : {}),
    ...(input.secondaryColor !== undefined ? { brandSecondaryColor: input.secondaryColor } : {}),
    ...(input.textColor !== undefined ? { brandTextColor: input.textColor } : {}),
    ...(input.fontFamily !== undefined ? { brandFontFamily: input.fontFamily } : {}),
    ...(input.borderRadius !== undefined ? { brandBorderRadius: input.borderRadius } : {}),
    ...(input.logoUrl !== undefined ? { brandLogoUrl: input.logoUrl ?? null } : {}),
    ...(input.logoHeight !== undefined ? { brandLogoHeight: input.logoHeight } : {}),
    ...(input.logoAlignment !== undefined ? { brandLogoAlignment: input.logoAlignment } : {}),
    ...(input.customCss !== undefined ? { customCss: nextCss } : {}),
    ...(input.themeMode !== undefined ? { themeMode: input.themeMode } : {}),
  });

  await invalidateTag(shopTag(shopDomain));

  log.info({ shopId }, 'Shop branding updated');
  return toBranding(row);
}

/**
 * Where and when COD is offered.
 *
 * Same cache rule as branding: the storefront config embeds all of it, so a
 * write has to invalidate the shop's tag or a merchant turns COD off, reloads
 * their storefront, and still sees the button.
 */
function toVisibility(
  row: NonNullable<Awaited<ReturnType<typeof repository.findVisibility>>>,
): ShopVisibilitySummary {
  return {
    codEnabled: row.codEnabled,
    replaceAddToCart: row.replaceAddToCart,
    replaceBuyNow: row.replaceBuyNow,
    enabledOnAllProducts: row.enabledOnAllProducts,
    includedProductGids: row.includedProductGids,
    excludedProductGids: row.excludedProductGids,
    includedCollectionGids: row.includedCollectionGids,
    allowedCountryCodes: row.allowedCountryCodes,
    blockedCountryCodes: row.blockedCountryCodes,
    allowedPostalPatterns: row.allowedPostalPatterns,
    blockedPostalPatterns: row.blockedPostalPatterns,
    // Decimal to string, never to a float.
    minOrderValue: row.minOrderValue?.toString() ?? null,
    maxOrderValue: row.maxOrderValue?.toString() ?? null,
  };
}

/**
 * What COD costs the shopper.
 *
 * Same cache rule as branding and visibility: these amounts are embedded in the
 * storefront config, so a write that does not invalidate the shop's tag leaves
 * a merchant looking at their own form still quoting the old delivery charge.
 */
function toFees(row: NonNullable<Awaited<ReturnType<typeof repository.findFees>>>): ShopFeesSummary {
  return {
    codFeeEnabled: row.codFeeEnabled,
    // Decimal to string, never to a float — these are added to an order total.
    codFeeAmount: row.codFeeAmount?.toString() ?? null,
    codFeeIsPercent: row.codFeeIsPercent,
    shippingFee: row.shippingFee?.toString() ?? null,
    freeShippingAbove: row.freeShippingAbove?.toString() ?? null,
  };
}

export async function getFees(shopId: string): Promise<ShopFeesSummary> {
  const row = await repository.findFees(shopId);
  if (!row) throw new NotFoundError('This shop has no settings record');

  return toFees(row);
}

export async function updateFees(
  shopId: string,
  shopDomain: string,
  input: UpdateFeesInput,
): Promise<ShopFeesSummary> {
  const current = await getFees(shopId);

  /**
   * A percentage above 100 would charge more in fees than the goods cost.
   *
   * Checked here rather than in the schema because either field can arrive
   * alone: a merchant switching an existing 49 to "percent" sends only
   * `codFeeIsPercent`, and the amount that makes it invalid is the stored one.
   */
  const isPercent = input.codFeeIsPercent ?? current.codFeeIsPercent;
  const amount = input.codFeeAmount === undefined ? current.codFeeAmount : input.codFeeAmount;

  if (isPercent && amount !== null && amount !== undefined && Number(amount) > 100) {
    throw new ValidationError('A percentage COD fee cannot be above 100%.');
  }

  const row = await repository.updateFees(shopId, {
    ...(input.codFeeEnabled !== undefined ? { codFeeEnabled: input.codFeeEnabled } : {}),
    ...(input.codFeeIsPercent !== undefined ? { codFeeIsPercent: input.codFeeIsPercent } : {}),
    ...(input.codFeeAmount !== undefined ? { codFeeAmount: input.codFeeAmount ?? null } : {}),
    ...(input.shippingFee !== undefined ? { shippingFee: input.shippingFee ?? null } : {}),
    ...(input.freeShippingAbove !== undefined
      ? { freeShippingAbove: input.freeShippingAbove ?? null }
      : {}),
  });

  await invalidateTag(shopTag(shopDomain));

  log.info({ shopId }, 'Shop COD fees updated');
  return toFees(row);
}

export async function getVisibility(shopId: string): Promise<ShopVisibilitySummary> {
  const row = await repository.findVisibility(shopId);
  if (!row) throw new NotFoundError('This shop has no settings record');

  return toVisibility(row);
}

export async function updateVisibility(
  shopId: string,
  shopDomain: string,
  input: UpdateVisibilityInput,
): Promise<ShopVisibilitySummary> {
  const row = await repository.updateVisibility(shopId, {
    ...(input.codEnabled !== undefined ? { codEnabled: input.codEnabled } : {}),
    ...(input.replaceAddToCart !== undefined ? { replaceAddToCart: input.replaceAddToCart } : {}),
    ...(input.replaceBuyNow !== undefined ? { replaceBuyNow: input.replaceBuyNow } : {}),
    ...(input.enabledOnAllProducts !== undefined
      ? { enabledOnAllProducts: input.enabledOnAllProducts }
      : {}),
    ...(input.includedProductGids !== undefined
      ? { includedProductGids: input.includedProductGids }
      : {}),
    ...(input.excludedProductGids !== undefined
      ? { excludedProductGids: input.excludedProductGids }
      : {}),
    ...(input.includedCollectionGids !== undefined
      ? { includedCollectionGids: input.includedCollectionGids }
      : {}),
    ...(input.allowedCountryCodes !== undefined
      ? { allowedCountryCodes: input.allowedCountryCodes }
      : {}),
    ...(input.blockedCountryCodes !== undefined
      ? { blockedCountryCodes: input.blockedCountryCodes }
      : {}),
    ...(input.allowedPostalPatterns !== undefined
      ? { allowedPostalPatterns: input.allowedPostalPatterns }
      : {}),
    ...(input.blockedPostalPatterns !== undefined
      ? { blockedPostalPatterns: input.blockedPostalPatterns }
      : {}),
    ...(input.minOrderValue !== undefined ? { minOrderValue: input.minOrderValue ?? null } : {}),
    ...(input.maxOrderValue !== undefined ? { maxOrderValue: input.maxOrderValue ?? null } : {}),
  });

  await invalidateTag(shopTag(shopDomain));

  log.info({ shopId, codEnabled: row.codEnabled }, 'Shop visibility updated');
  return toVisibility(row);
}

export async function saveOnboarding(
  shopId: string,
  step: number,
  completed: boolean,
): Promise<OnboardingState> {
  await repository.updateOnboarding(shopId, step, completed);
  return { step, completed };
}

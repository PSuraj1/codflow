import type { Decimal } from '@prisma/client/runtime/library';
import {
  LOGO_HEIGHT_DEFAULT,
  PLAN_LIMITS,
  RTL_LOCALES,
  SubscriptionStatus,
  type ButtonPlacement,
  type Locale,
  type LogoAlignment,
  type Plan,
  type StorefrontBranding,
  type StorefrontButton,
  type StorefrontConfig,
  type StorefrontLocalization,
  type StorefrontPricing,
  type ThemeMode,
} from '@codflow/shared';
import { contentVersion, remember, shopTag } from '../../lib/cache';
import { withPlanExemption } from '../../lib/planExemption';
import { createLogger } from '../../lib/logger';
import { loadOfflineSession } from '../../shopify/sessionStorage';
import { tryAdminGraphql } from '../../shopify/graphql';
import {
  PRODUCT_COLLECTIONS_QUERY,
  type ProductCollectionsResponse,
} from '../../shopify/queries/product';
import * as pixelsService from '../pixels/service';
import * as upsellsRepository from '../upsells/repository';
import * as repository from './repository';
import { toProductGid } from './dto';
import type { StorefrontShopRecord } from './repository';

const log = createLogger('storefront-service');

/**
 * Assembles the public storefront configuration.
 *
 * This runs on every product page view of every installed store, so the shape
 * of the work matters more than usual:
 *
 *  - The whole result is cached in Redis keyed on shop *and* product, because
 *    eligibility is per-product. Uncached, one shopper equals three database
 *    queries.
 *  - Eligibility resolution short-circuits aggressively. The default
 *    (`enabledOnAllProducts`) needs no lookup at all; product allow/deny lists
 *    are answered from columns already loaded; only collection-scoped rules
 *    reach Shopify, and that result is cached separately with a longer TTL
 *    because collection membership changes far less often than app settings.
 *  - A shop that is uninstalled, unsubscribed or has COD switched off returns a
 *    fully-formed `disabled` config rather than a 404. The theme extension can
 *    then simply not render, instead of having to interpret an error.
 */

/** Config responses. Short enough that a settings change is visible quickly. */
const CONFIG_TTL_SECONDS = 300;

/**
 * Collection membership. Longer, because a merchant reorganizing collections is
 * rare and a stale answer only affects whether one product shows a COD button.
 */
const COLLECTIONS_TTL_SECONDS = 3_600;

/** Serializes a Prisma Decimal for the wire without losing precision to a float. */
function money(value: Decimal | null): string | null {
  return value === null ? null : value.toString();
}

/**
 * Config returned when COD is unavailable.
 *
 * Deliberately complete rather than partial: the theme extension reads
 * `enabled` and stops, but returning a well-formed object means a future field
 * added to the disabled path cannot produce `undefined` in the browser.
 */
function disabledConfig(): StorefrontConfig {
  return {
    enabled: false,
    eligible: false,
    replaceAddToCart: false,
    replaceBuyNow: false,
    buttons: [],
    branding: {
      primaryColor: '#008060',
      secondaryColor: '#004C3F',
      textColor: '#202223',
      fontFamily: 'inherit',
      borderRadius: 8,
      logoUrl: null,
      logoHeight: LOGO_HEIGHT_DEFAULT,
      logoAlignment: 'left',
      customCss: null,
      themeMode: 'SYSTEM',
    },
    bumps: [],
    localization: { defaultLocale: 'EN', enabledLocales: ['EN'], rtl: false },
    pricing: {
      codFeeEnabled: false,
      codFeeAmount: null,
      codFeeIsPercent: false,
      shippingFee: null,
      freeShippingAbove: null,
      minOrderValue: null,
      maxOrderValue: null,
    },
    formId: null,
    requireOtp: false,
    // No pixels either: a shop with COD switched off should not be firing
    // conversion events, and an uninstalled one has no business loading a
    // merchant's tags at all.
    pixels: [],
    version: 'disabled',
  };
}

/**
 * Whether the shop's plan still entitles it to serve COD.
 *
 * A cancelled or expired subscription disables the storefront rather than
 * silently downgrading it. Frozen is treated as still-serving: Shopify freezes
 * subscriptions for payment issues that merchants routinely resolve within
 * hours, and taking a working store's checkout offline over a card decline is
 * a worse outcome than a few days of unpaid usage.
 */
function planAllowsStorefront(shop: StorefrontShopRecord): boolean {
  const subscription = shop.subscription;
  if (!subscription) return true;

  return (
    subscription.status === SubscriptionStatus.ACTIVE ||
    subscription.status === SubscriptionStatus.TRIALING ||
    subscription.status === SubscriptionStatus.FROZEN
  );
}

/**
 * Resolves whether one product may be ordered by COD.
 *
 * Precedence is exclusion first: a merchant who both includes a collection and
 * excludes a specific product within it means the exclusion. Reading it the
 * other way would surface COD on a product they explicitly turned it off for,
 * which is the failure mode that generates support tickets.
 */
async function resolveEligibility(
  shop: StorefrontShopRecord,
  productGid: string | null,
): Promise<boolean> {
  const settings = shop.settings;
  if (!settings) return true;

  // Without a product in view — a cart or collection page — eligibility is a
  // property of the cart, checked when the form is opened.
  if (!productGid) return true;

  if (settings.excludedProductGids.includes(productGid)) return false;

  if (settings.enabledOnAllProducts) return true;

  if (settings.includedProductGids.includes(productGid)) return true;

  if (settings.includedCollectionGids.length === 0) return false;

  const collections = await productCollections(shop.domain, productGid);
  return collections.some((gid) => settings.includedCollectionGids.includes(gid));
}

/**
 * Collections containing a product, cached.
 *
 * Requires the merchant's offline session. If it is missing — mid-reinstall, or
 * a revoked token — this returns empty, which makes a collection-scoped product
 * ineligible. Failing closed is right here: showing a COD button the merchant
 * did not enable creates orders they did not agree to accept.
 */
async function productCollections(shopDomain: string, productGid: string): Promise<string[]> {
  return remember(
    {
      namespace: 'product-collections',
      parts: [shopDomain, productGid],
      tag: shopTag(shopDomain),
      ttlSeconds: COLLECTIONS_TTL_SECONDS,
    },
    async () => {
      const session = await loadOfflineSession(shopDomain);

      if (!session) {
        log.warn({ shop: shopDomain }, 'No offline session — cannot resolve collection eligibility');
        return [];
      }

      const result = await tryAdminGraphql<ProductCollectionsResponse>(
        session,
        PRODUCT_COLLECTIONS_QUERY,
        { variables: { id: productGid } },
      );

      return result?.product?.collections.nodes.map((node) => node.id) ?? [];
    },
  );
}

function toButton(record: repository.StorefrontButtonRecord, allowCustomCss: boolean): StorefrontButton {
  return {
    placement: record.placement as ButtonPlacement,
    label: record.label,
    subLabel: record.subLabel,
    iconName: record.iconName,
    bgColor: record.bgColor,
    textColor: record.textColor,
    borderColor: record.borderColor,
    borderRadius: record.borderRadius,
    fontSize: record.fontSize,
    fontWeight: record.fontWeight,
    paddingY: record.paddingY,
    paddingX: record.paddingX,
    fullWidth: record.fullWidth,
    // Custom CSS is a paid feature. Withholding it here rather than at save
    // time means a merchant who downgrades keeps their rules and gets them back
    // on re-upgrade, instead of having them silently deleted.
    customCss: allowCustomCss ? record.customCss : null,
    showOnMobile: record.showOnMobile,
    showOnDesktop: record.showOnDesktop,
    showAfterScrollPx: record.showAfterScrollPx,
    stickyOffsetBottom: record.stickyOffsetBottom,
    floatingPosition: record.floatingPosition,
    openInPopup: record.openInPopup,
    animation: record.animation,
  };
}

function toBranding(shop: StorefrontShopRecord, allowCustomCss: boolean): StorefrontBranding {
  const settings = shop.settings;

  return {
    primaryColor: settings?.brandPrimaryColor ?? '#008060',
    secondaryColor: settings?.brandSecondaryColor ?? '#004C3F',
    textColor: settings?.brandTextColor ?? '#202223',
    fontFamily: settings?.brandFontFamily ?? 'inherit',
    borderRadius: settings?.brandBorderRadius ?? 8,
    logoUrl: settings?.brandLogoUrl ?? null,
    logoHeight: settings?.brandLogoHeight ?? LOGO_HEIGHT_DEFAULT,
    logoAlignment: (settings?.brandLogoAlignment ?? 'left') as LogoAlignment,
    customCss: allowCustomCss ? (settings?.customCss ?? null) : null,
    themeMode: (settings?.themeMode ?? 'SYSTEM') as ThemeMode,
  };
}

function toLocalization(shop: StorefrontShopRecord): StorefrontLocalization {
  const settings = shop.settings;
  const defaultLocale = (settings?.defaultLocale ?? 'EN') as Locale;
  const enabledLocales = (settings?.enabledLocales ?? ['EN']) as Locale[];

  return {
    defaultLocale,
    enabledLocales,
    // `forceRtl` overrides detection for merchants whose primary market reads
    // right-to-left even though their default locale does not.
    rtl: settings?.forceRtl === true || RTL_LOCALES.includes(defaultLocale),
  };
}

function toPricing(shop: StorefrontShopRecord): StorefrontPricing {
  const settings = shop.settings;

  return {
    codFeeEnabled: settings?.codFeeEnabled ?? false,
    codFeeAmount: money(settings?.codFeeAmount ?? null),
    codFeeIsPercent: settings?.codFeeIsPercent ?? false,
    shippingFee: money(settings?.shippingFee ?? null),
    freeShippingAbove: money(settings?.freeShippingAbove ?? null),
    minOrderValue: money(settings?.minOrderValue ?? null),
    maxOrderValue: money(settings?.maxOrderValue ?? null),
  };
}

/** Builds the config from scratch. Called only on a cache miss. */
async function buildConfig(shopDomain: string, productId: string | null): Promise<StorefrontConfig> {
  const shop = await repository.findShopForStorefront(shopDomain);

  if (!shop || !shop.isActive || !shop.settings?.codEnabled || !planAllowsStorefront(shop)) {
    return disabledConfig();
  }

  // Exempt shops get the top plan here too, so an operator's own storefront
  // renders their custom CSS rather than silently dropping it.
  const plan = withPlanExemption(shop.domain, (shop.subscription?.plan ?? 'FREE') as Plan);
  const allowCustomCss = PLAN_LIMITS[plan].customCss;

  const productGid = productId ? toProductGid(productId) : null;

  const [eligible, buttonRecords, form, pixels, bumps] = await Promise.all([
    resolveEligibility(shop, productGid),
    repository.findEnabledButtons(shop.id),
    repository.findActiveForm(shop.id),
    // Client-side pixels only, and the projection carries no access tokens —
    // this whole payload is public.
    pixelsService.storefrontPixels(shop.id),
    upsellsRepository.listEnabled(shop.id),
  ]);

  const payload = {
    enabled: true,
    eligible,
    replaceAddToCart: shop.settings.replaceAddToCart,
    replaceBuyNow: shop.settings.replaceBuyNow,
    buttons: buttonRecords.map((record) => toButton(record, allowCustomCss)),
    bumps: bumps.map((bump) => ({
      id: bump.id,
      title: bump.title,
      description: bump.description,
      // Decimal to string, never to a float.
      price: bump.price.toString(),
      defaultChecked: bump.defaultChecked,
    })),
    branding: toBranding(shop, allowCustomCss),
    localization: toLocalization(shop),
    pricing: toPricing(shop),
    formId: form?.id ?? null,
    requireOtp: form?.requireOtp ?? false,
    pixels,
  };

  // Hashed last, over the finished payload, so the version changes if and only
  // if something the browser can observe changed.
  return { ...payload, version: contentVersion(payload) };
}

/** Public entry point. Cached per shop and product. */
export async function getConfig(
  shopDomain: string,
  productId: string | null,
): Promise<StorefrontConfig> {
  return remember(
    {
      namespace: 'storefront-config',
      parts: [shopDomain, productId ?? '-'],
      tag: shopTag(shopDomain),
      ttlSeconds: CONFIG_TTL_SECONDS,
    },
    () => buildConfig(shopDomain, productId),
  );
}

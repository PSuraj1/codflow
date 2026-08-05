import type { ButtonPlacement, Locale, ThemeMode } from '../enums.js';
import type { LogoAlignment } from './branding.js';
import type { StorefrontPixel } from './pixels.js';
import type { StorefrontOrderBump } from './upsells.js';

/**
 * The public storefront contract.
 *
 * Everything here is served to anonymous shoppers by `/api/storefront/*`, which
 * makes it the one contract in the app with a hard privacy constraint: a field
 * added to these types is a field published to the internet. Merchant email
 * addresses, fraud thresholds, OTP provider settings, order counts and internal
 * ids must never appear.
 *
 * The allow/deny product lists are a specific example. They exist on
 * `ShopSettings`, but returning them would let anyone enumerate which products a
 * merchant has excluded from COD. Instead the server resolves eligibility for
 * the single product being viewed and returns a boolean.
 */

/** Presentation of one COD button. Mirrors the merchant's `ButtonConfig` row. */
export interface StorefrontButton {
  readonly placement: ButtonPlacement;
  readonly label: string;
  readonly subLabel: string | null;
  readonly iconName: string | null;

  readonly bgColor: string;
  readonly textColor: string;
  readonly borderColor: string;
  readonly borderRadius: number;
  readonly fontSize: number;
  readonly fontWeight: string;
  readonly paddingY: number;
  readonly paddingX: number;
  readonly fullWidth: boolean;
  /** Merchant-authored CSS. Only present on plans that allow it. */
  readonly customCss: string | null;

  readonly showOnMobile: boolean;
  readonly showOnDesktop: boolean;
  /** Pixels scrolled before a sticky or floating button appears. 0 = immediately. */
  readonly showAfterScrollPx: number;
  readonly stickyOffsetBottom: number;
  readonly floatingPosition: string;
  readonly openInPopup: boolean;
  readonly animation: string;
}

/** Shop-level branding applied to the form and any button without an override. */
export interface StorefrontBranding {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly textColor: string;
  readonly fontFamily: string;
  readonly borderRadius: number;
  readonly logoUrl: string | null;
  readonly logoHeight: number;
  readonly logoAlignment: LogoAlignment;
  readonly customCss: string | null;
  readonly themeMode: ThemeMode;
}

export interface StorefrontLocalization {
  readonly defaultLocale: Locale;
  readonly enabledLocales: readonly Locale[];
  /** True when the resolved locale renders right-to-left. Drives `dir` on the form. */
  readonly rtl: boolean;
}

/**
 * COD economics the storefront needs in order to show an accurate total before
 * the shopper submits.
 *
 * Advisory only. These same rules are re-applied server-side at order creation,
 * and the server never trusts a price that arrived from the browser — a shopper
 * editing `codFee` in devtools changes what they *see*, not what they are
 * charged.
 */
export interface StorefrontPricing {
  readonly codFeeEnabled: boolean;
  readonly codFeeAmount: string | null;
  readonly codFeeIsPercent: boolean;
  readonly shippingFee: string | null;
  readonly freeShippingAbove: string | null;
  readonly minOrderValue: string | null;
  readonly maxOrderValue: string | null;
}

/**
 * Response body of `GET /api/storefront/config`.
 *
 * One request serves an entire page view. `version` changes whenever any
 * contributing record does, so the browser can keep a copy in `sessionStorage`
 * and skip the fetch entirely on subsequent page views within a session.
 */
export interface StorefrontConfig {
  /** False when COD is switched off, the plan lapsed, or the app was uninstalled. */
  readonly enabled: boolean;
  /** False when this specific product is excluded by the merchant's rules. */
  readonly eligible: boolean;

  readonly replaceAddToCart: boolean;
  readonly replaceBuyNow: boolean;

  readonly buttons: readonly StorefrontButton[];
  readonly branding: StorefrontBranding;
  readonly localization: StorefrontLocalization;
  readonly pricing: StorefrontPricing;

  /**
   * Tick-box add-ons offered on the form. Empty when the merchant has none.
   *
   * Prices are advisory here, exactly like `pricing` above: the server
   * re-resolves every amount from its own records at submission, so a shopper
   * editing one in devtools changes what they see and not what they pay.
   */
  readonly bumps: readonly StorefrontOrderBump[];

  /**
   * Identifier of the active COD form. The form definition itself is fetched
   * lazily when a shopper first opens it, so a page view that never converts
   * does not pay for it.
   */
  readonly formId: string | null;
  readonly requireOtp: boolean;

  /**
   * Pixels the browser should load and fire.
   *
   * Contains no access tokens by construction — a Conversions API credential on
   * a public endpoint would let anyone write conversions into the merchant's ad
   * account. Client-side events use the same deterministic `eventId` the server
   * computes, so the provider discards the duplicate rather than counting the
   * conversion twice.
   */
  readonly pixels: readonly StorefrontPixel[];

  /** Content hash of everything above. Used for client-side cache validation. */
  readonly version: string;
}

/** Query accepted by `GET /api/storefront/config`. */
export interface StorefrontConfigQuery {
  readonly shop: string;
  /** Numeric id or GID of the product in view. Omitted on cart and collection pages. */
  readonly productId?: string;
}

/**
 * Header the theme extension sends to identify the shop.
 *
 * Duplicated in the query string because a request may be a `<link rel=preload>`
 * or a beacon, neither of which can set headers.
 */
export const STOREFRONT_SHOP_HEADER = 'x-codflow-shop';

/** `sessionStorage` key holding the cached config, keyed by shop and product. */
export const STOREFRONT_CACHE_PREFIX = 'codflow:config:';

/**
 * The deduplication key shared between the browser and the server.
 *
 * Both sides compute it from the same inputs, so a provider receiving a
 * client-side Purchase and a server-side Purchase for one order sees a single
 * conversion. A random id on either side would double-count every sale, which
 * silently corrupts the merchant's ad bidding — the campaign appears twice as
 * efficient as it is and budget follows.
 */
export function pixelEventId(orderReference: string, eventName: string): string {
  return `${orderReference}-${eventName}`.toLowerCase();
}

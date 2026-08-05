/**
 * Where and when the COD form is offered.
 *
 * Every field here has been read by the storefront since the form was built and
 * had no admin screen, so a merchant could not turn COD off, restrict it to a
 * few products, or stop offering it to countries they do not ship to.
 *
 * Note what is *not* here: which page the button appears on. That is a property
 * of each button placement and lives on `ButtonConfig` — the COD button screen
 * owns it. Duplicating it here would give a merchant two controls for one
 * behaviour and no way to tell which won.
 */

/** Precedence is exclusion first — see `resolveEligibility` in the storefront service. */
export interface ShopVisibilitySummary {
  /** Master switch. Off means the storefront renders nothing at all. */
  readonly codEnabled: boolean;

  /** Hide the theme's own Add to cart / Buy it now and drive everything through COD. */
  readonly replaceAddToCart: boolean;
  readonly replaceBuyNow: boolean;

  /** True offers COD everywhere except the exclusions below. */
  readonly enabledOnAllProducts: boolean;
  readonly includedProductGids: readonly string[];
  readonly excludedProductGids: readonly string[];
  readonly includedCollectionGids: readonly string[];

  /**
   * Empty means every country. A non-empty allow list is exclusive: anything
   * not named is refused, which is the point — a merchant who ships to two
   * countries should not have to enumerate the other two hundred.
   */
  readonly allowedCountryCodes: readonly string[];
  readonly blockedCountryCodes: readonly string[];

  /** Prefixes or patterns, matched against the shopper's postal code. */
  readonly allowedPostalPatterns: readonly string[];
  readonly blockedPostalPatterns: readonly string[];

  /** Decimal strings, or null for no bound. COD is refused outside the range. */
  readonly minOrderValue: string | null;
  readonly maxOrderValue: string | null;
}

/** Body of `PATCH /api/admin/shop/visibility`. Every field optional. */
export type UpdateShopVisibility = Partial<ShopVisibilitySummary>;

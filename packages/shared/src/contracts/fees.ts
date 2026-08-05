/**
 * What COD costs the shopper.
 *
 * Every field here has been read by the pricing engine since it was written and
 * had no admin screen, so a merchant could not change their delivery charge or
 * their COD fee without someone running SQL against the database.
 *
 * Note what is *not* here: `minOrderValue` and `maxOrderValue`. They are money
 * too, but they decide *whether* COD is offered rather than what it costs, so
 * they sit with the rest of the eligibility rules on `ShopVisibilitySummary`.
 * Splitting on that line keeps one question per screen — "who can use COD" is
 * not the same question as "what do they pay".
 *
 * Amounts are decimal strings throughout, never numbers. These are compared
 * against and added to an order total the server resolved from Shopify, and a
 * float loses paise on the way.
 */
export interface ShopFeesSummary {
  /** Off charges nothing, whatever `codFeeAmount` says. */
  readonly codFeeEnabled: boolean;
  /** Flat amount, or a percentage of the subtotal when `codFeeIsPercent`. */
  readonly codFeeAmount: string | null;
  readonly codFeeIsPercent: boolean;

  /** Flat delivery charge added to every COD order. Null charges nothing. */
  readonly shippingFee: string | null;
  /**
   * Subtotal at or above which delivery becomes free. Null never waives it.
   *
   * Compared against the subtotal rather than the total, so the COD fee cannot
   * push an order over the threshold and pay for its own delivery.
   */
  readonly freeShippingAbove: string | null;
}

/** Body of `PATCH /api/admin/shop/fees`. Every field optional. */
export type UpdateShopFees = Partial<ShopFeesSummary>;

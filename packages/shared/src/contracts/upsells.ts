/**
 * Upsells.
 *
 * COD merchants make thin margins on the goods and real margins on the extras,
 * so a tick box that adds shipping protection or gift wrapping to an order is
 * often worth more than any change to the form itself.
 *
 * What exists today is the **order bump** — the "1-tick upsell": a flat-priced
 * add-on the shopper accepts on the form itself. The other two ideas on the
 * Upsells screen, a multi-step 1-click offer sequence and an exit-intent
 * downsell, are not built; they need an offer-state machine and exit detection
 * respectively, and neither is a variation on this.
 */

/** An order bump as the admin edits it. */
export interface OrderBumpSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  /** Decimal string. Never a number — this is added to an order total. */
  readonly price: string;
  readonly isEnabled: boolean;
  readonly position: number;
}

/** An order bump as the storefront renders it. No merchant-only fields. */
export interface StorefrontOrderBump {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly price: string;
}

/**
 * What a shopper accepted, snapshotted onto the order.
 *
 * A snapshot rather than a reference: a merchant who later edits the price or
 * deletes the bump must not rewrite what an existing order charged.
 */
export interface SelectedBump {
  readonly id: string;
  readonly title: string;
  readonly price: string;
}

export type CreateOrderBump = Omit<OrderBumpSummary, 'id'>;
export type UpdateOrderBump = Partial<CreateOrderBump>;

/**
 * How many bumps one form may carry.
 *
 * A limit rather than none, because the tick boxes sit between the shopper and
 * the submit button — six add-ons is a form nobody finishes.
 */
export const MAX_ORDER_BUMPS = 5;

/**
 * Postal code lookup.
 *
 * A COD form asks a shopper for their full address on a phone, usually with one
 * thumb. Every field removed is measurably more completed orders, and PIN code
 * is the one field that can *derive* two others — so filling city and state
 * from it is the single highest-leverage change available to the form.
 *
 * It also catches the most expensive kind of address error. A COD parcel with a
 * mistyped PIN code is dispatched, undelivered, and returned — the merchant
 * pays freight both ways and is left with a restocked item. Rejecting a PIN
 * code that does not exist costs the shopper two seconds at the form.
 *
 * **The lookup is server-side**, through the app proxy, for three reasons:
 * the shopper's browser never talks to a third party we do not control; the
 * result is cached in Redis, where one lookup serves every shopper who ever
 * enters that PIN code; and the provider can be replaced without shipping a new
 * theme asset to every merchant.
 */

/** What a lookup can conclude. */
export const PostalLookupStatus = {
  /** Recognised, and the address fields below are populated. */
  FOUND: 'found',
  /** Well-formed for the country but no such postal code exists. */
  NOT_FOUND: 'not_found',
  /** Does not match the country's postal format at all. */
  INVALID_FORMAT: 'invalid_format',
  /** Real, but the merchant does not deliver there. */
  NOT_SERVICEABLE: 'not_serviceable',
  /**
   * The lookup could not be completed.
   *
   * Deliberately distinct from `NOT_FOUND`. A provider outage must never read
   * as "your address is wrong" — the shopper is told nothing, the fields stay
   * editable, and the order proceeds. Blocking checkout because a lookup
   * service is down would turn someone else's outage into lost COD orders.
   */
  UNAVAILABLE: 'unavailable',
} as const;

export type PostalLookupStatus = (typeof PostalLookupStatus)[keyof typeof PostalLookupStatus];

/** `GET /apps/codflow/postal?code=…&country=…` */
export interface PostalLookupResult {
  readonly status: PostalLookupStatus;
  readonly postalCode: string;
  readonly countryCode: string;

  /** Populated only when `status` is `found`. */
  readonly city: string | null;
  readonly state: string | null;
  readonly stateCode: string | null;
  /**
   * Other localities sharing the PIN code.
   *
   * Indian PIN codes routinely cover several localities, and picking the first
   * silently puts the wrong one on the parcel. The form offers these as a
   * choice when there is more than one rather than guessing.
   */
  readonly localities: readonly string[];

  /** Merchant-facing reason, shown under the field. Null when there is nothing to say. */
  readonly message: string | null;
}

/**
 * Postal formats, by ISO country.
 *
 * Only countries the app can actually resolve are listed. A country absent from
 * this map skips lookup entirely rather than guessing at a pattern — a false
 * "invalid PIN code" on a valid address is far more damaging than no
 * validation, because the shopper cannot argue with it and simply leaves.
 */
export const POSTAL_FORMATS: Readonly<
  Record<string, { readonly pattern: RegExp; readonly length: number; readonly label: string }>
> = {
  IN: { pattern: /^[1-9][0-9]{5}$/, length: 6, label: 'PIN code' },
};

/** Whether lookup is supported for a country at all. */
export function supportsPostalLookup(countryCode: string | null | undefined): boolean {
  return Boolean(countryCode && POSTAL_FORMATS[countryCode.toUpperCase()]);
}

/** Whether a postal code is well-formed for its country. Unknown countries pass. */
export function isValidPostalFormat(countryCode: string, postalCode: string): boolean {
  const format = POSTAL_FORMATS[countryCode.toUpperCase()];
  if (!format) return true;

  return format.pattern.test(postalCode.trim());
}

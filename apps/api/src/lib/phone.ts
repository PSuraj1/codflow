import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Phone normalization.
 *
 * The phone number is the load-bearing field of a COD order — it is how the
 * merchant confirms before dispatch, and how the fraud engine recognises a
 * repeat offender. Both uses need one canonical form, because the same person
 * types `098765 43210`, `+91 98765 43210` and `0091-9876543210` on three
 * different visits, and a blacklist keyed on the raw string catches none of
 * them.
 *
 * E.164 is that canonical form. `phone` keeps what the shopper typed (it is
 * what the merchant will read out loud); `phoneE164` is what every lookup uses.
 */

export interface NormalizedPhone {
  /** E.164, e.g. `+919876543210`. Null when the number could not be parsed. */
  readonly e164: string | null;
  /** Whether the number is valid for its country, not merely well-shaped. */
  readonly valid: boolean;
  readonly countryCode: string | null;
  /** `mobile`, `fixed_line`, … when determinable. Feeds the fraud engine. */
  readonly type: string | null;
}

/**
 * Parses a phone number, using the order's country as the default region.
 *
 * The region matters: `9876543210` is a valid Indian mobile and an invalid US
 * number, and without a hint libphonenumber cannot tell which was meant. The
 * shopper's selected country is the best available hint, which is why this is
 * called after the address fields are resolved rather than during field-level
 * validation.
 */
export function normalizePhone(raw: string, defaultCountry?: string | null): NormalizedPhone {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { e164: null, valid: false, countryCode: null, type: null };
  }

  try {
    const parsed = parsePhoneNumberFromString(
      trimmed,
      defaultCountry ? (defaultCountry.toUpperCase() as CountryCode) : undefined,
    );

    if (!parsed) {
      return { e164: null, valid: false, countryCode: null, type: null };
    }

    return {
      e164: parsed.number,
      valid: parsed.isValid(),
      countryCode: parsed.country ?? null,
      type: parsed.getType() ?? null,
    };
  } catch {
    // libphonenumber throws on some malformed inputs rather than returning
    // undefined. An unparseable number is a validation result, not an outage.
    return { e164: null, valid: false, countryCode: null, type: null };
  }
}

/**
 * True for numbers that are obviously fabricated.
 *
 * Catches the patterns people type when they want the goods but not the phone
 * call: all-identical digits, simple ascending or descending runs. Deliberately
 * conservative — a false positive here rejects a real customer's order, so it
 * only flags sequences no real allocation plan would ever produce.
 */
export function looksFabricated(e164: string): boolean {
  const digits = e164.replace(/\D/g, '');

  // Strip the country code before looking at the pattern: +1 111 111 1111 is
  // fabricated, but the leading 1 is legitimate.
  const national = digits.slice(-10);
  if (national.length < 7) return false;

  if (/^(\d)\1+$/.test(national)) return true;

  const ascending = '01234567890123456789';
  const descending = '98765432109876543210';

  return ascending.includes(national) || descending.includes(national);
}

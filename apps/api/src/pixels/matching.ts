import { createHash } from 'node:crypto';

/**
 * Advanced matching.
 *
 * Ad platforms match a conversion to a user by comparing SHA-256 hashes of
 * normalized personal details. Two properties follow, and both matter:
 *
 *  - **Nothing identifying leaves the server in the clear.** A hash is one-way,
 *    so the provider learns whether it already knows this person without
 *    CODkar handing over a shopper's phone number.
 *  - **Normalization is the entire feature.** The hash of `"Asha@Example.com "`
 *    and `"asha@example.com"` are different strings, and a provider comparing
 *    them finds nothing. A normalization bug does not error — it produces a
 *    perfectly valid hash that matches nobody, which is indistinguishable from
 *    the feature being switched off. That is why every rule below is spelled
 *    out and tested rather than inferred.
 *
 * The rules follow Meta's published specification, which TikTok, Snapchat and
 * Pinterest all mirror closely enough to share.
 */

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Hashes a value, or returns null when there is nothing to hash. */
function hashOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : sha256(trimmed);
}

/**
 * Email: trimmed and lowercased.
 *
 * Deliberately *not* stripping Gmail dots or plus-suffixes. Providers hash the
 * address as the user typed it, so `a.b+tag@gmail.com` normalized to
 * `ab@gmail.com` would hash to something the provider has never seen.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized.includes('@') ? normalized : null;
}

/**
 * Phone: digits only, including the country code, with no leading `+` or zeros.
 *
 * The pipeline stores E.164 (`+919876543210`), so this strips the `+` to leave
 * `919876543210`. Passing E.164 straight through is the single most common
 * advanced-matching mistake — the leading `+` changes the hash and the match
 * rate silently drops to zero.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;

  // A number stored with international access prefixes rather than E.164.
  const withoutTrunk = digits.replace(/^0+/, '');
  return withoutTrunk.length >= 7 ? withoutTrunk : null;
}

/**
 * Names: lowercased, with punctuation and whitespace removed.
 *
 * `O'Brien` and `o brien` both become `obrien`, which is what lets a provider
 * match the same person across two differently-typed checkouts. Accents are
 * decomposed and stripped for the same reason — `José` and `Jose` are one
 * person, and providers normalize them identically.
 */
export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null;

  const normalized = name
    .normalize('NFD')
    // Combining diacritical marks.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

  return normalized.length > 0 ? normalized : null;
}

/** City: lowercased with all spaces and punctuation removed. */
export function normalizeCity(city: string | null | undefined): string | null {
  return normalizeName(city);
}

/**
 * State or province: two-letter lowercase where possible.
 *
 * Providers expect the ISO subdivision code. A full name is passed through
 * normalized rather than guessed at — an incorrect two-letter code is worse
 * than a long one, because it may match a *different* region.
 */
export function normalizeState(state: string | null | undefined): string | null {
  if (!state) return null;

  const normalized = state.trim().toLowerCase().replace(/[^a-z]/g, '');
  return normalized.length > 0 ? normalized : null;
}

/**
 * Postal code: lowercased, spaces removed.
 *
 * US ZIP+4 is truncated to the first five digits, which is what Meta specifies.
 * Other formats are left whole — a UK postcode truncated to five characters
 * would match the wrong area entirely.
 */
export function normalizeZip(
  zip: string | null | undefined,
  countryCode?: string | null,
): string | null {
  if (!zip) return null;

  const normalized = zip.trim().toLowerCase().replace(/\s/g, '');
  if (normalized.length === 0) return null;

  if (countryCode?.toUpperCase() === 'US') {
    const digits = normalized.replace(/\D/g, '');
    return digits.length >= 5 ? digits.slice(0, 5) : digits;
  }

  return normalized;
}

/** Country: two-letter lowercase ISO 3166-1 alpha-2. */
export function normalizeCountry(country: string | null | undefined): string | null {
  if (!country) return null;

  const normalized = country.trim().toLowerCase().replace(/[^a-z]/g, '');
  // Only a real alpha-2 code is usable; a full country name would hash to
  // something no provider recognises.
  return normalized.length === 2 ? normalized : null;
}

/** The personal details a conversion may carry, before hashing. */
export interface MatchingInput {
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly country?: string | null;
}

/** Hashed identifiers, keyed by the app's own field names. */
export interface HashedMatching {
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
}

/**
 * Normalizes and hashes every available identifier.
 *
 * Absent fields stay null rather than becoming the hash of an empty string —
 * `sha256("")` is a valid-looking hex value that every provider would compare
 * against and never match, and sending it for every shopper would make the
 * match-quality score worse rather than better.
 */
export function buildMatching(input: MatchingInput): HashedMatching {
  return {
    email: hashOrNull(normalizeEmail(input.email)),
    phone: hashOrNull(normalizePhone(input.phone)),
    firstName: hashOrNull(normalizeName(input.firstName)),
    lastName: hashOrNull(normalizeName(input.lastName)),
    city: hashOrNull(normalizeCity(input.city)),
    state: hashOrNull(normalizeState(input.state)),
    zip: hashOrNull(normalizeZip(input.zip, input.country)),
    country: hashOrNull(normalizeCountry(input.country)),
  };
}

/** Drops null entries, since providers reject explicit nulls in the payload. */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }

  return result as Partial<T>;
}

/**
 * How many identifiers were resolved.
 *
 * Surfaced in the admin because match quality is roughly proportional to it,
 * and a merchant whose form does not collect an email should be told that is
 * why their attribution is weak — rather than being left to guess.
 */
export function matchingStrength(matching: HashedMatching): number {
  return Object.values(matching).filter((value) => value !== null).length;
}

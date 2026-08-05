import { createLogger } from './logger';
import { toError } from './errors';

const log = createLogger('postal');

/**
 * Postal code resolution.
 *
 * Same posture as `ipIntel`, for the same reason: this runs on a path a shopper
 * is waiting on, against a service nobody here operates.
 *
 *  1. **Bounded.** A hard timeout. A slow provider must not hold up a form the
 *     shopper is trying to fill.
 *  2. **Fails open.** Any failure resolves to `null`, which the caller reports
 *     as `unavailable` — the fields stay editable and the order proceeds.
 *     Turning a provider outage into a blocked checkout would cost the merchant
 *     far more than the convenience is worth.
 *  3. **Shape-checked.** The response is validated field by field rather than
 *     cast. A provider that changes its JSON should degrade to "unavailable",
 *     not put `undefined` into a shopper's shipping address.
 */

const TIMEOUT_MS = 3_500;

export interface PostalRecord {
  readonly city: string;
  readonly state: string;
  readonly localities: readonly string[];
}

/** One provider, for one country. */
interface PostalProvider {
  readonly country: string;
  lookup(postalCode: string): Promise<PostalRecord | null>;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`Provider answered ${response.status}`);

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * India Post, via the public `postalpincode.in` mirror.
 *
 * Its response shape is idiosyncratic and worth naming: a single-element array
 * wrapping `{ Status, PostOffice: [...] }`, where `Status` is the string
 * `"Success"` or `"Error"` rather than a code, and `PostOffice` is `null` — not
 * an empty array — when nothing matched.
 *
 * A PIN code covers many post offices, and their `Name` values are the
 * localities within it. `District` is what Indian shipping labels call the city,
 * and every post office under one PIN shares it, so the first is representative.
 */
const indiaPost: PostalProvider = {
  country: 'IN',

  async lookup(postalCode: string): Promise<PostalRecord | null> {
    const payload = await getJson(
      `https://api.postalpincode.in/pincode/${encodeURIComponent(postalCode)}`,
    );

    const first = Array.isArray(payload) ? (payload[0] as Record<string, unknown> | undefined) : undefined;
    if (!first || readString(first, 'Status') !== 'Success') return null;

    const offices = Array.isArray(first.PostOffice)
      ? (first.PostOffice as Record<string, unknown>[])
      : [];

    if (offices.length === 0) return null;

    const head = offices[0] as Record<string, unknown>;
    const city = readString(head, 'District');
    const state = readString(head, 'State');

    // Without both, the record cannot fill the two fields it exists to fill.
    if (!city || !state) return null;

    const localities = offices
      .map((office) => readString(office, 'Name'))
      .filter((name): name is string => name !== null);

    return {
      city,
      state,
      // Deduplicated and bounded: a dense urban PIN can list dozens, and a
      // hundred-entry dropdown is worse than none.
      localities: [...new Set(localities)].slice(0, 25),
    };
  },
};

const PROVIDERS: readonly PostalProvider[] = [indiaPost];

/**
 * Resolves a postal code, or null when it cannot be resolved.
 *
 * Null covers three different situations on purpose — unsupported country, no
 * such code, provider unreachable — because the *caller* has the context needed
 * to tell a shopper which one it was, and this layer does not.
 */
export async function lookupPostalCode(
  countryCode: string,
  postalCode: string,
): Promise<PostalRecord | null> {
  const provider = PROVIDERS.find((entry) => entry.country === countryCode.toUpperCase());
  if (!provider) return null;

  try {
    return await provider.lookup(postalCode);
  } catch (error) {
    log.warn(
      { err: toError(error), countryCode, postalCode },
      'Postal lookup failed — the shopper fills the fields themselves',
    );
    return null;
  }
}

/** Countries with a provider. Drives whether the form bothers to ask. */
export function supportedPostalCountries(): string[] {
  return PROVIDERS.map((provider) => provider.country);
}

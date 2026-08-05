import {
  POSTAL_FORMATS,
  PostalLookupStatus,
  isValidPostalFormat,
  type PostalLookupResult,
} from '@codflow/shared';
import { prisma } from '../../db/prisma';
import { remember, shopTag } from '../../lib/cache';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import { lookupPostalCode, type PostalRecord } from '../../lib/postal';

const log = createLogger('postal-service');

/**
 * Postal lookup for the storefront.
 *
 * Two things happen here that the provider layer deliberately does not do:
 * caching, and applying the merchant's own delivery rules.
 *
 * The cache is the important one. Postal data is effectively static — a PIN
 * code's district does not change — so one successful lookup can serve every
 * shopper who ever types it, across every store on the platform. That turns a
 * third-party call on the checkout path into a Redis read for all but the first
 * shopper, and it is what makes depending on a free public API defensible.
 */

/** A month. Postal boundaries change on a timescale of years, not days. */
const CACHE_TTL_SECONDS = 30 * 24 * 3_600;

/**
 * Merchant delivery rules for a postal code.
 *
 * Patterns are prefixes, not regular expressions. A merchant typing `4` to mean
 * "all of Maharashtra" is the expected usage, and handing an arbitrary regex
 * from a settings field to the matcher on a request path is both a footgun and
 * a denial-of-service waiting to happen.
 */
function isServiceable(
  postalCode: string,
  allowed: readonly string[],
  blocked: readonly string[],
): boolean {
  const normalized = postalCode.trim();

  if (blocked.some((prefix) => prefix && normalized.startsWith(prefix.trim()))) return false;

  // An empty allow list means "everywhere except the blocked list", which is
  // what a merchant who has never opened the setting expects.
  if (allowed.length === 0) return true;

  return allowed.some((prefix) => prefix && normalized.startsWith(prefix.trim()));
}

interface ShopPostalRules {
  readonly allowed: readonly string[];
  readonly blocked: readonly string[];
}

async function rulesFor(shopDomain: string): Promise<ShopPostalRules> {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: {
      settings: { select: { allowedPostalPatterns: true, blockedPostalPatterns: true } },
    },
  });

  return {
    allowed: shop?.settings?.allowedPostalPatterns ?? [],
    blocked: shop?.settings?.blockedPostalPatterns ?? [],
  };
}

/** The shared, shop-independent half: what the provider says this code is. */
async function resolveRecord(countryCode: string, postalCode: string): Promise<PostalRecord | null> {
  return remember(
    {
      namespace: 'postal',
      // Not tagged to a shop — the answer is the same for everyone, and that is
      // the entire point of caching it.
      tag: 'postal',
      parts: [countryCode, postalCode],
      ttlSeconds: CACHE_TTL_SECONDS,
    },
    () => lookupPostalCode(countryCode, postalCode),
  );
}

function result(
  status: PostalLookupStatus,
  postalCode: string,
  countryCode: string,
  extra: Partial<PostalLookupResult> = {},
): PostalLookupResult {
  return {
    status,
    postalCode,
    countryCode,
    city: null,
    state: null,
    stateCode: null,
    localities: [],
    message: null,
    ...extra,
  };
}

export async function lookup(
  shopDomain: string,
  countryCode: string,
  rawPostalCode: string,
): Promise<PostalLookupResult> {
  const country = countryCode.toUpperCase();
  const postalCode = rawPostalCode.trim();
  const format = POSTAL_FORMATS[country];
  const label = format?.label ?? 'postal code';

  // No provider for this country. Reported as unavailable rather than invalid:
  // the app has no opinion, so it must not imply the address is wrong.
  if (!format) {
    return result(PostalLookupStatus.UNAVAILABLE, postalCode, country);
  }

  if (!isValidPostalFormat(country, postalCode)) {
    return result(PostalLookupStatus.INVALID_FORMAT, postalCode, country, {
      message: `Enter a valid ${format.length}-digit ${label}.`,
    });
  }

  let record: PostalRecord | null;

  try {
    record = await resolveRecord(country, postalCode);
  } catch (error) {
    // Fails open. The shopper fills city and state themselves and the order
    // proceeds — a lookup outage must never become a checkout outage.
    log.error({ err: toError(error), country, postalCode }, 'Postal lookup errored');
    return result(PostalLookupStatus.UNAVAILABLE, postalCode, country);
  }

  if (!record) {
    return result(PostalLookupStatus.NOT_FOUND, postalCode, country, {
      message: `We could not find that ${label}. Check it and try again.`,
    });
  }

  const rules = await rulesFor(shopDomain).catch(() => ({ allowed: [], blocked: [] }));

  if (!isServiceable(postalCode, rules.allowed, rules.blocked)) {
    // The merchant's own rule, so it is stated as their policy rather than as
    // an error the shopper made.
    return result(PostalLookupStatus.NOT_SERVICEABLE, postalCode, country, {
      city: record.city,
      state: record.state,
      message: 'Cash on delivery is not available for this area.',
    });
  }

  return result(PostalLookupStatus.FOUND, postalCode, country, {
    city: record.city,
    state: record.state,
    stateCode: null,
    localities: record.localities,
  });
}

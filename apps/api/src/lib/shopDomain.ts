import { sanitizeShopDomain } from '../shopify/client';
import { BadRequestError } from './errors';

/**
 * Shop domain normalization.
 *
 * A shop identifier reaches this app through four different channels, each with
 * its own formatting:
 *
 *   - the `dest` claim of a session token   -> `https://shop.myshopify.com`
 *   - the `shop` query parameter            -> `shop.myshopify.com`
 *   - the `X-Shopify-Shop-Domain` header    -> `shop.myshopify.com`
 *   - a storefront `Origin` header          -> `https://shop.myshopify.com` or a custom domain
 *
 * All of them are attacker-influenceable, so every one funnels through
 * `sanitizeShop`, which only accepts genuine `*.myshopify.com` hosts. This is
 * the check that stops a request from steering the app at a domain the caller
 * controls — without it, `shop=evil.com` would make the app send a merchant's
 * access token to `evil.com/admin/api`.
 */

/** Strips scheme, path, port and trailing slash, then validates. Returns null when invalid. */
export function normalizeShopDomain(value: string | null | undefined): string | null {
  if (!value) return null;

  let candidate = value.trim().toLowerCase();

  // `dest` and `Origin` arrive with a scheme; `shop` params usually do not.
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    try {
      candidate = new URL(candidate).host;
    } catch {
      return null;
    }
  }

  // Drop anything after the host — `shop.myshopify.com/admin` is a common paste.
  const slash = candidate.indexOf('/');
  if (slash !== -1) candidate = candidate.slice(0, slash);

  // A port is never legitimate on a myshopify domain, but sanitizeShop would
  // reject the whole value rather than ignoring it.
  const colon = candidate.indexOf(':');
  if (colon !== -1) candidate = candidate.slice(0, colon);

  return sanitizeShopDomain(candidate);
}

/** Same as {@link normalizeShopDomain} but throws, for call sites that cannot continue. */
export function requireShopDomain(value: string | null | undefined): string {
  const shop = normalizeShopDomain(value);

  if (!shop) {
    throw new BadRequestError('A valid myshopify.com shop domain is required', {
      details: { shop: value ?? null },
    });
  }

  return shop;
}

/**
 * The store handle Shopify uses in admin URLs: `shop.myshopify.com` -> `shop`.
 *
 * Needed to build `https://admin.shopify.com/store/<handle>/…` deep links, which
 * is the only form that works for merchants on the unified admin domain.
 */
export function shopHandle(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/, '');
}

import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { config } from '../config/env';
import { normalizeShopDomain } from '../lib/shopDomain';

/**
 * Security headers for an embedded Shopify app.
 *
 * An embedded app is loaded inside an iframe by the Shopify admin, which
 * inverts two of Helmet's defaults:
 *
 *  - `X-Frame-Options: DENY` must not be sent. It is unconditional and would
 *    block the admin from framing the app at all.
 *  - `frame-ancestors` cannot be a static value. Shopify requires it to name
 *    the *specific* shop making the request plus `admin.shopify.com`, so it has
 *    to be computed per request from the `shop` parameter. Sending a wildcard
 *    instead is an app-review rejection and would let any site frame the app
 *    and clickjack a merchant into changing COD settings.
 *
 * `Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy` are relaxed
 * for the same reason: assets are legitimately loaded across the Shopify CDN,
 * the app's own origin, and merchant-uploaded logos.
 */

const SHOPIFY_ADMIN_ORIGIN = 'https://admin.shopify.com';

/** Origins that may frame this app when no specific shop is identifiable. */
const FALLBACK_FRAME_ANCESTORS = [SHOPIFY_ADMIN_ORIGIN, 'https://*.myshopify.com'];

/**
 * Computes `frame-ancestors` from the request.
 *
 * Shopify always includes `shop` on the initial embedded load and App Bridge
 * preserves it on client-side navigation. When it is absent or fails
 * sanitization — a bookmark, a probe, a crafted value — the policy falls back
 * to the wildcard form, which still excludes every non-Shopify origin.
 */
function frameAncestorsFor(req: Request): string[] {
  const shop = normalizeShopDomain(
    (req.query.shop as string | undefined) ?? req.get('x-shopify-shop-domain'),
  );

  return shop ? [`https://${shop}`, SHOPIFY_ADMIN_ORIGIN] : [...FALLBACK_FRAME_ANCESTORS];
}

const baseHelmet = helmet({
  // Set manually below, because frame-ancestors depends on the request.
  contentSecurityPolicy: false,
  // Would block the admin iframe outright. frame-ancestors replaces it.
  frameguard: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // The admin passes the shop through the URL; a full referrer to third-party
  // resources would leak which store is using the app.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: config.isProduction
    ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
    : false,
});

function contentSecurityPolicy(req: Request, res: Response, next: NextFunction): void {
  const directives = [
    `frame-ancestors ${frameAncestorsFor(req).join(' ')}`,
    // The SPA loads App Bridge from Shopify's CDN, and Polaris injects styles.
    `default-src 'self'`,
    `script-src 'self' https://cdn.shopify.com`,
    `style-src 'self' 'unsafe-inline' https://cdn.shopify.com`,
    `img-src 'self' data: blob: https://cdn.shopify.com https://*.myshopify.com https://res.cloudinary.com`,
    `font-src 'self' data: https://cdn.shopify.com`,
    `connect-src 'self' https://*.myshopify.com https://admin.shopify.com`,
    // Nothing in this app is a plugin host or a form POST target elsewhere.
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ];

  if (config.isProduction) {
    directives.push('upgrade-insecure-requests');
  }

  res.setHeader('Content-Security-Policy', directives.join('; '));
  next();
}

/** Ordered security middleware: Helmet's static headers, then the dynamic CSP. */
export const securityHeaders = [baseHelmet, contentSecurityPolicy] as const;

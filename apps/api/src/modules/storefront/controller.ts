import type { NextFunction, Request, Response } from 'express';
import { STOREFRONT_SHOP_HEADER } from '@codflow/shared';
import { ok } from '../../lib/http';
import { requireShopDomain } from '../../lib/shopDomain';
import type { StorefrontConfigQueryInput } from './dto';
import * as service from './service';

/**
 * Storefront HTTP surface.
 *
 * Public and unauthenticated — a shopper has no credentials to present — which
 * makes these the app's most exposed endpoints. Three defences apply, and none
 * of them live in this file: the router rate-limits by shop and IP, the DTO
 * bounds every input, and the service selects only publishable columns.
 *
 * What this file *is* responsible for is caching. Getting the headers right
 * here is what keeps a viral product page from turning into a database load
 * problem: Shopify's CDN and the shopper's browser both honour them, so the
 * majority of page views never reach the origin at all.
 */

/**
 * `GET /api/storefront/config`
 *
 * `Cache-Control` is deliberately layered:
 *
 *  - `max-age=60` — the browser reuses the response for a minute, which covers
 *    a shopper moving between variants of the same product.
 *  - `s-maxage=300` — shared caches hold it five times longer, matching the
 *    server-side Redis TTL, because they serve many shoppers rather than one.
 *  - `stale-while-revalidate=600` — after expiry the cache may serve the old
 *    copy while fetching a new one in the background. A COD button rendered
 *    from ten-minute-old settings is a far better outcome than a button that
 *    appears late because the origin was slow.
 */
export async function getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as StorefrontConfigQueryInput;

    // The header is the preferred source: a query string is visible in CDN logs
    // and referrer chains, whereas the header is not. The query parameter
    // remains supported because a `<link rel=preload>` cannot set headers.
    const shopDomain = requireShopDomain(req.get(STOREFRONT_SHOP_HEADER) ?? query.shop);

    const config = await service.getConfig(shopDomain, query.productId ?? null);

    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    );

    // The response varies by shop, and the shop can arrive in a header. Without
    // this a shared cache could hand one merchant's config to another's
    // storefront.
    res.setHeader('Vary', `Origin, ${STOREFRONT_SHOP_HEADER}`);

    // Lets the browser skip the body entirely when its cached copy still
    // matches — the common case on repeat views.
    res.setHeader('ETag', `"${config.version}"`);

    if (req.get('if-none-match') === `"${config.version}"`) {
      res.status(304).end();
      return;
    }

    ok(res, config);
  } catch (error) {
    next(error);
  }
}

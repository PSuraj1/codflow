import { z } from 'zod';

/**
 * Auth module contracts.
 *
 * Every value here arrives on a query string from a browser Shopify redirected,
 * so all of it is attacker-influenceable. The `shop` parameter in particular is
 * the one that matters: it decides which domain the app redirects to, and an
 * unvalidated value turns these routes into an open redirect.
 *
 * The schemas only check *shape*. Domain validity is enforced separately by
 * `requireShopDomain`, which is the sole authority on what counts as a real
 * myshopify host.
 */

export const ShopQuerySchema = z.object({
  shop: z.string().min(1, 'shop is required').max(255),
});

export type ShopQuery = z.infer<typeof ShopQuerySchema>;

/**
 * Exit-iframe parameters.
 *
 * `target` is an enum, not a URL. That is the whole security property of this
 * route: the destination is chosen from a fixed set the server builds itself,
 * so no caller can turn a page on the app's own domain into a redirector to
 * somewhere of their choosing.
 *
 * Note that `validate` replaces `req.query` with the parsed object and Zod
 * strips unknown keys — so a parameter the handler reads must be declared here
 * or it will silently disappear.
 */
export const ExitIframeQuerySchema = z.object({
  shop: z.string().min(1, 'shop is required').max(255),
  target: z.enum(['install', 'app']).default('install'),
});

export type ExitIframeQuery = z.infer<typeof ExitIframeQuerySchema>;

/**
 * Query parameters Shopify appends when it sends a merchant to the app.
 *
 * `host` is a base64url encoding of the admin host and is what App Bridge needs
 * to talk to its parent frame. `embedded=1` distinguishes a load inside the
 * admin iframe from a direct navigation, which is the difference between
 * rendering the app and redirecting into the admin.
 */
export const EntryQuerySchema = z.object({
  shop: z.string().min(1).max(255).optional(),
  host: z.string().max(512).optional(),
  embedded: z.string().max(4).optional(),
  hmac: z.string().max(128).optional(),
  timestamp: z.string().max(32).optional(),
  session: z.string().max(512).optional(),
  id_token: z.string().max(4096).optional(),
});

export type EntryQuery = z.infer<typeof EntryQuerySchema>;

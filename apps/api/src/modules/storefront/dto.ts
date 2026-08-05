import { z } from 'zod';

/**
 * Storefront request contracts.
 *
 * These validate input from anonymous shoppers — the least trusted source in
 * the app — so the schemas are tighter than the admin's. Bounded lengths
 * matter as much as the format: an unbounded `productId` becomes part of a
 * Redis cache key, and a megabyte of query string would let anyone fill the
 * cache with junk.
 */

/**
 * Shopify product identifier, in either form the storefront produces.
 *
 * Liquid gives `product.id` as a bare number; the Storefront API and the web
 * pixel both use GIDs. Accepting both and normalizing server-side is cheaper
 * than making the theme extension guess.
 */
const productId = z
  .string()
  .max(64)
  .regex(
    /^(\d+|gid:\/\/shopify\/Product\/\d+)$/,
    'productId must be a numeric product id or a Shopify product GID',
  );

export const StorefrontConfigQuerySchema = z.object({
  /**
   * Optional here because the shop may instead arrive in the
   * `X-CodFlow-Shop` header, which is the preferred transport — a query string
   * ends up in CDN logs and referrer chains, a header does not. The controller
   * requires one of the two; domain validity is enforced separately by
   * `requireShopDomain`. This only bounds the shape so an oversized value never
   * reaches a cache key.
   */
  shop: z.string().max(255).optional(),
  productId: productId.optional(),
});

export type StorefrontConfigQueryInput = z.infer<typeof StorefrontConfigQuerySchema>;

/** Normalizes either accepted form to a GID. */
export function toProductGid(value: string): string {
  return value.startsWith('gid://') ? value : `gid://shopify/Product/${value}`;
}

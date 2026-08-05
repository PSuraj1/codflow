/**
 * Product queries used on the storefront path.
 *
 * Kept minimal on purpose. These run behind a cache but still on an anonymous
 * request, so every field costs query-cost budget against the merchant's
 * Shopify rate limit — which is shared with the merchant's other apps.
 */

/**
 * Collections a product belongs to.
 *
 * Needed only when a merchant restricts COD to specific collections. 250 is
 * Shopify's page ceiling and far beyond any realistic membership count; a
 * product in more than 250 collections would be an unusual catalogue, and
 * paginating for that case would add a second round trip to every miss.
 */
export const PRODUCT_COLLECTIONS_QUERY = /* GraphQL */ `
  query CodFlowProductCollections($id: ID!) {
    product(id: $id) {
      id
      status
      collections(first: 250) {
        nodes {
          id
        }
      }
    }
  }
`;

export interface ProductCollectionsResponse {
  product: {
    id: string;
    status: string;
    collections: { nodes: Array<{ id: string }> };
  } | null;
}

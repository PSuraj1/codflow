/**
 * Variant pricing and availability.
 *
 * This is the single most security-sensitive query in the app. The COD form
 * posts variant ids and quantities from a shopper's browser; it does **not**
 * post prices, and nothing that arrives from the browser is ever used as one.
 * Every amount on a COD order is resolved here, server-side, immediately before
 * the order is created.
 *
 * Skipping that and trusting a `price` field in the request body is the classic
 * way COD apps get exploited: a shopper edits the value in devtools and takes
 * delivery of goods at a price the merchant never set — and because COD is paid
 * on arrival, the merchant discovers it only when the courier hands over the
 * package.
 */

export const VARIANTS_BY_IDS_QUERY = /* GraphQL */ `
  query CodFlowVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        price
        availableForSale
        inventoryQuantity
        inventoryPolicy
        image {
          url
        }
        selectedOptions {
          name
          value
        }
        product {
          id
          title
          status
          handle
          featuredMedia {
            preview {
              image {
                url
              }
            }
          }
        }
      }
    }
  }
`;

export interface VariantNode {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  image: { url: string } | null;
  selectedOptions: Array<{ name: string; value: string }>;
  product: {
    id: string;
    title: string;
    status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
    handle: string;
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  };
}

export interface VariantsResponse {
  /** Null entries correspond to ids that do not exist or are not variants. */
  nodes: Array<VariantNode | null>;
}

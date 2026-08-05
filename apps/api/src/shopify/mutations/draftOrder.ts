/**
 * Order creation, via the draft order path.
 *
 * There are two ways to put a COD order into Shopify, and this picks the one
 * that is stable rather than the one that is shortest:
 *
 *  - `orderCreate` writes an order in a single call, but its input type has
 *    changed shape across recent API versions (transactions, financial status
 *    and the options argument have all moved), and a mismatch surfaces as a
 *    GraphQL error at runtime rather than a compile failure.
 *  - `draftOrderCreate` + `draftOrderComplete` has been stable for years.
 *    `draftOrderComplete(paymentPending: true)` produces exactly COD
 *    semantics: a real order, financial status `pending`, nothing captured.
 *
 * The second also happens to model the merchant's own choice. `createAsDraftOrder`
 * decides whether the draft is completed automatically or left for the merchant
 * to review — the same two calls either way, with the second one conditional.
 *
 * Money fields use the `…WithCurrency` variants where they exist. Shopify has
 * been deprecating the bare `Money` scalar in favour of `MoneyInput` across the
 * Admin API, and the currency-bearing form is the one that survives.
 */

export const DRAFT_ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation CodFlowDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface DraftOrderCreateResponse {
  draftOrderCreate: {
    draftOrder: {
      id: string;
      name: string;
      invoiceUrl: string | null;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      customer: { id: string } | null;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

/**
 * Completes a draft into a real order.
 *
 * `paymentPending: true` is the whole point: it creates the order with an
 * outstanding balance instead of trying to capture payment, which is what cash
 * on delivery is. Omitting it makes Shopify attempt a capture against a payment
 * method that does not exist.
 */
export const DRAFT_ORDER_COMPLETE_MUTATION = /* GraphQL */ `
  mutation CodFlowDraftOrderComplete($id: ID!, $paymentPending: Boolean!) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        order {
          id
          name
          displayFinancialStatus
          # Shopify's own thank-you page for this order. Carries a token that
          # cannot be derived from the order id, so it has to be captured here
          # and stored — there is no way to reconstruct it later.
          statusPageUrl
          customer {
            id
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface DraftOrderCompleteResponse {
  draftOrderComplete: {
    draftOrder: {
      id: string;
      order: {
        id: string;
        name: string;
        displayFinancialStatus: string | null;
        statusPageUrl: string | null;
        customer: { id: string } | null;
      } | null;
    } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

/**
 * Adds tags to the created order.
 *
 * Done as a separate call rather than through the draft's `tags` field, because
 * tags set on a draft do not reliably carry across to the completed order —
 * and the merchant's automation, their Shopify Flow triggers and their order
 * filters all key on the tag being on the *order*.
 */
export const ORDER_TAGS_ADD_MUTATION = /* GraphQL */ `
  mutation CodFlowTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export interface TagsAddResponse {
  tagsAdd: {
    node: { id: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

/** Shopify address input. Every field is optional on Shopify's side. */
export interface MailingAddressInput {
  address1?: string;
  address2?: string;
  city?: string;
  company?: string;
  countryCode?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  provinceCode?: string;
  zip?: string;
}

export interface DraftOrderLineItemInput {
  /** Present for catalogue items. */
  variantId?: string;
  /** Present for custom lines — the COD fee and the delivery charge. */
  title?: string;
  originalUnitPriceWithCurrency?: { amount: string; currencyCode: string };
  requiresShipping?: boolean;
  taxable?: boolean;
  quantity: number;
}

export interface DraftOrderInput {
  email?: string;
  phone?: string;
  note?: string;
  tags?: string[];
  lineItems: DraftOrderLineItemInput[];
  shippingAddress?: MailingAddressInput;
  billingAddress?: MailingAddressInput;
  /** Surfaced on the order as "Additional details". */
  customAttributes?: Array<{ key: string; value: string }>;
}

/**
 * Billing queries.
 *
 * Read through the **Admin API**, using the offline session the app already
 * holds, rather than the Partner API. Two reasons:
 *
 *  1. `currentAppInstallation` answers for the shop that is asking, so there is
 *     no organisation-wide token to store and no way for a bug to read another
 *     merchant's subscription.
 *  2. The Partner API is a separate credential with separate rate limits and no
 *     per-shop scoping. Reconciliation would then depend on a secret that is
 *     absent in development, which is precisely when reconciliation bugs are
 *     cheapest to find.
 *
 * Under managed pricing the app never *creates* a subscription — Shopify does,
 * from the Partner Dashboard configuration — so there is no mutation here. This
 * file only ever asks what is already true.
 */

export const ACTIVE_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query CodFlowActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        createdAt
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                interval
                price {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface ActiveSubscriptionsResponse {
  currentAppInstallation: {
    activeSubscriptions: Array<{
      id: string;
      /**
       * The plan's name as configured in the Partner Dashboard.
       *
       * Under managed pricing this is the only signal that says *which* plan the
       * merchant bought — there is no plan enum on the response — so the mapping
       * from this string to `Plan` has to be tolerant. See `resolvePlan`.
       */
      name: string;
      status: string;
      /** True for a development-store or Partner test charge. Never billed. */
      test: boolean;
      trialDays: number;
      createdAt: string;
      currentPeriodEnd: string | null;
      lineItems: Array<{
        plan: {
          pricingDetails: {
            __typename: string;
            interval?: string;
            price?: { amount: string; currencyCode: string };
          };
        };
      }>;
    }>;
  } | null;
}

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { BillingOverview, BillingSubscription, Plan, UpgradeUrlResponse } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { openTop, showToast } from '../lib/appBridge';
import { SESSION_QUERY_KEY } from './useSession';

/**
 * Billing data access.
 *
 * The upgrade flow is the part with a trap in it. Managed pricing is a
 * Shopify-hosted page served with `frame-ancestors 'none'`, so navigating to it
 * from inside the embedded app renders an empty panel and reports nothing
 * anywhere — it looks exactly like a dead button. `openTop` is not an
 * optimisation here; without it the feature does not work at all.
 */

export const BILLING_KEY = ['billing'] as const;

export function useBilling(): UseQueryResult<BillingOverview, Error> {
  return useQuery({
    queryKey: BILLING_KEY,
    queryFn: () => api.get<BillingOverview>('/admin/billing'),
    // Usage counters move with every order, and a merchant near their cap is
    // the one most likely to be watching this screen.
    staleTime: 30_000,
  });
}

/**
 * Sends the merchant to Shopify to choose a plan.
 *
 * The app cannot start a subscription itself, so this is a handoff rather than
 * a purchase: the URL is fetched, opened in the top frame, and whatever the
 * merchant confirms on Shopify's screen comes back through the
 * `app_subscriptions/update` webhook and the refresh below.
 */
export function useOpenPricingPage() {
  return useMutation({
    mutationFn: (plan?: Plan) =>
      api.post<UpgradeUrlResponse>('/admin/billing/upgrade-url', plan ? { plan } : {}),

    onSuccess: (result) => openTop(result.url),
    onError: (error: Error) => showToast(error.message, true),
  });
}

/**
 * Re-checks the plan against Shopify.
 *
 * For the moment a merchant comes back from the pricing page. The webhook is
 * the reliable path but can land seconds later, and in the meantime the app
 * would show them the plan they just left — which reads as the upgrade having
 * failed.
 *
 * `verified: false` means the check itself could not run. Saying so matters:
 * the alternative is telling a merchant their plan is unchanged when the truth
 * is that nobody managed to ask.
 */
export function useRefreshSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ subscription: BillingSubscription; verified: boolean }>('/admin/billing/refresh'),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: BILLING_KEY });
      // The session carries the plan too, and a stale copy there would keep
      // feature gates closed on screens the merchant visits next.
      void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });

      showToast(
        result.verified
          ? `You are on the ${result.subscription.planName} plan`
          : 'Could not reach Shopify to confirm your plan — showing the last known one',
        !result.verified,
      );
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

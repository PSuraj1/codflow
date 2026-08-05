import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  OrderPushStatus,
  RetryPushResult,
  StuckOrderGroup,
  StuckOrdersPage,
  VerifyOrderResult,
} from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Order recovery data access.
 *
 * The list is polled rather than fetched once. A merchant opens this screen
 * because orders are not reaching Shopify, and the useful thing after a retry is
 * watching the row leave the list — not being left to guess whether anything
 * happened and reload by hand.
 */

export const STUCK_ORDERS_QUERY_KEY = ['orders', 'stuck'] as const;

/**
 * One group of stuck orders, a page at a time.
 *
 * `useInfiniteQuery` rather than accumulating pages by hand, so a refetch
 * re-fetches every page already on screen instead of resetting the merchant to
 * the top — they are usually working down a list and retrying as they go.
 *
 * Polling stays, because the point of the screen is watching orders leave it,
 * but it only refreshes pages already loaded rather than fetching more.
 */
export function useStuckOrders(group: StuckOrderGroup) {
  return useInfiniteQuery({
    queryKey: [...STUCK_ORDERS_QUERY_KEY, group],
    queryFn: ({ pageParam }) =>
      api.get<StuckOrdersPage>('/admin/orders/stuck', {
        query: { group, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
      }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
}

export function useOrderPushStatus(reference: string | null) {
  return useQuery({
    queryKey: ['orders', 'push-status', reference],
    queryFn: () => api.get<OrderPushStatus>(`/admin/orders/${reference}/push-status`),
    enabled: reference !== null,
  });
}

/**
 * Asks for one order to be sent again.
 *
 * The server owns the decision. It refuses with a conflict when a gate holds or
 * blocks the order, or when the order already exists in Shopify — and that
 * message is the merchant's answer, so it is surfaced verbatim rather than
 * replaced with a generic failure.
 */
export function useRetryPush() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reference: string) =>
      api.post<RetryPushResult>(`/admin/orders/${reference}/retry-push`),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: STUCK_ORDERS_QUERY_KEY });

      // "Queued", not "on its way": the job being accepted says nothing about
      // anything consuming it, and with no worker running the order does not
      // move. Overstating that is the same false reassurance the enqueue
      // helpers already risk by swallowing their own errors.
      showToast(
        result.queued
          ? `${result.reference} queued for Shopify`
          : `${result.reference} could not be queued — the job queue may be down`,
        !result.queued,
      );
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

/**
 * Marks a customer's phone as verified by the merchant.
 *
 * The push is only queued if verification was the *only* thing holding the
 * order, so the result says which happened — a merchant who verifies an order
 * that is also in fraud review needs to know it has not moved.
 */
export function useVerifyOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reference: string) =>
      api.post<VerifyOrderResult>(`/admin/orders/${reference}/verify`),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: STUCK_ORDERS_QUERY_KEY });

      showToast(
        result.queued
          ? `${result.reference} verified and queued for Shopify`
          : `${result.reference} verified — still held: ${result.heldReason ?? 'see the order'}`,
      );
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

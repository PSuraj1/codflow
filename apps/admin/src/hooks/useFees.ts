import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ShopFeesSummary, UpdateShopFees } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * COD fee and shipping data access.
 *
 * Same shape as `useBranding`, and for the same reason: the server invalidates
 * the storefront cache on every write, so a changed delivery charge is quoted
 * on the form within seconds rather than after the config TTL.
 */

export const FEES_QUERY_KEY = ['shop', 'fees'] as const;

export function useFees(): UseQueryResult<ShopFeesSummary, Error> {
  return useQuery({
    queryKey: FEES_QUERY_KEY,
    queryFn: () => api.get<ShopFeesSummary>('/admin/shop/fees'),
  });
}

export function useUpdateFees() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateShopFees) => api.patch<ShopFeesSummary>('/admin/shop/fees', input),

    onSuccess: (saved) => {
      queryClient.setQueryData(FEES_QUERY_KEY, saved);
      showToast('Fees saved — your storefront updates within a few seconds');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

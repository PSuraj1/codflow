import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ShopBrandingSummary, UpdateShopBranding } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Shop appearance data access.
 *
 * The server invalidates the storefront cache on every write, so a saved colour
 * is live within seconds rather than after the config TTL — which is what makes
 * "save, reload the storefront, see it" the obvious way to check a change.
 */

export const BRANDING_QUERY_KEY = ['shop', 'branding'] as const;

export function useBranding(): UseQueryResult<ShopBrandingSummary, Error> {
  return useQuery({
    queryKey: BRANDING_QUERY_KEY,
    queryFn: () => api.get<ShopBrandingSummary>('/admin/shop/branding'),
  });
}

export function useUpdateBranding() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateShopBranding) =>
      api.patch<ShopBrandingSummary>('/admin/shop/branding', input),

    onSuccess: (saved) => {
      queryClient.setQueryData(BRANDING_QUERY_KEY, saved);
      showToast('Appearance saved — your storefront updates within a few seconds');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

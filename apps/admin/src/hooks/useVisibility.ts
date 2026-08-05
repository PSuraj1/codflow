import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ShopVisibilitySummary, UpdateShopVisibility } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Where and when COD is offered.
 *
 * The one screen whose settings can stop orders arriving entirely, so the toast
 * says which way the master switch went rather than a neutral "saved" — a
 * merchant who turned COD off by accident should read it here, not work it out
 * from an empty dashboard tomorrow.
 */

export const VISIBILITY_QUERY_KEY = ['shop', 'visibility'] as const;

export function useVisibility(): UseQueryResult<ShopVisibilitySummary, Error> {
  return useQuery({
    queryKey: VISIBILITY_QUERY_KEY,
    queryFn: () => api.get<ShopVisibilitySummary>('/admin/shop/visibility'),
  });
}

export function useUpdateVisibility() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateShopVisibility) =>
      api.patch<ShopVisibilitySummary>('/admin/shop/visibility', input),

    onSuccess: (saved) => {
      queryClient.setQueryData(VISIBILITY_QUERY_KEY, saved);

      showToast(
        saved.codEnabled
          ? 'Saved — your storefront updates within a few seconds'
          : 'Saved — cash on delivery is now switched off',
        !saved.codEnabled,
      );
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

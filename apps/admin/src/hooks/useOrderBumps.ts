import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { CreateOrderBump, OrderBumpSummary, UpdateOrderBump } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Order bump data access.
 *
 * The server invalidates the storefront cache on every write, so a new add-on
 * appears on the COD form within seconds rather than after the config TTL.
 */

export const BUMPS_QUERY_KEY = ['upsells', 'bumps'] as const;

export function useOrderBumps(): UseQueryResult<OrderBumpSummary[], Error> {
  return useQuery({
    queryKey: BUMPS_QUERY_KEY,
    queryFn: () => api.get<OrderBumpSummary[]>('/admin/upsells/bumps'),
  });
}

export function useCreateOrderBump() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateOrderBump) =>
      api.post<OrderBumpSummary>('/admin/upsells/bumps', input),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BUMPS_QUERY_KEY });
      showToast('Add-on created');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useUpdateOrderBump() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...input }: UpdateOrderBump & { id: string }) =>
      api.patch<OrderBumpSummary>(`/admin/upsells/bumps/${id}`, input),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BUMPS_QUERY_KEY });
      showToast('Add-on saved — your storefront updates within a few seconds');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useDeleteOrderBump() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/upsells/bumps/${id}`),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BUMPS_QUERY_KEY });
      showToast('Add-on deleted');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

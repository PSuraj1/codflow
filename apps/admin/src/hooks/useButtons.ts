import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ButtonConfigSummary, CustomizableButtonPlacement, UpdateButtonConfig } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * COD button configuration data access.
 *
 * One query for every placement rather than one per placement: the customizer
 * shows them all as tabs, and six requests to render a screen the merchant may
 * only change one tab of is a waterfall for nothing.
 */

export const BUTTONS_QUERY_KEY = ['buttons'] as const;

export function useButtons(): UseQueryResult<ButtonConfigSummary[], Error> {
  return useQuery({
    queryKey: BUTTONS_QUERY_KEY,
    queryFn: () => api.get<ButtonConfigSummary[]>('/admin/buttons'),
  });
}

export interface UpdateButtonVariables extends UpdateButtonConfig {
  placement: CustomizableButtonPlacement;
}

export function useUpdateButton() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ placement, ...changes }: UpdateButtonVariables) =>
      api.patch<ButtonConfigSummary>(`/admin/buttons/${placement}`, changes),

    onSuccess: (saved) => {
      // Patched in place rather than refetched: the response is the persisted
      // record, and a refetch would blank the editor mid-edit if the merchant
      // has already moved on to another field.
      queryClient.setQueryData<ButtonConfigSummary[]>(BUTTONS_QUERY_KEY, (current) =>
        current?.map((button) => (button.placement === saved.placement ? saved : button)),
      );

      showToast('Button saved — your storefront updates within a few seconds');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingState, SetupGuide } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * The setup checklist.
 *
 * `staleTime` is short compared with the rest of the dashboard because this is
 * the one card a merchant acts on while watching it. Enabling the app embed
 * happens in the Shopify theme editor — another tab — so they come back
 * expecting the step to have ticked. `refetchOnWindowFocus` is what makes that
 * work, and is the reason this hook does not share the analytics stale time.
 */

export const SETUP_KEY = ['setup'] as const;

export function useSetupGuide() {
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => api.get<SetupGuide>('/admin/shop/setup'),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Hides the card for good.
 *
 * Reuses the pre-existing onboarding endpoint rather than adding one. `step` is
 * the legacy cursor and is written only so the column is not left misleading;
 * `completed` is the flag the guide actually reads back as `dismissed`.
 */
export function useDismissSetupGuide() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (stepsDone: number) =>
      api.put<OnboardingState>('/admin/shop/onboarding', {
        step: stepsDone,
        completed: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETUP_KEY });
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

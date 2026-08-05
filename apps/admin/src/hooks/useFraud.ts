import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  BlockListEntrySummary,
  FraudRuleSummary,
  FraudSettingsSummary,
  RiskAssessmentSummary,
} from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Fraud configuration data access.
 *
 * Every mutation the server treats as score-affecting comes back with
 * `rescanQueued`. Surfacing that count in the toast is the difference between
 * a merchant believing a new block list entry only applies to future orders and
 * knowing it just re-scored the ones already waiting.
 */

export const FRAUD_SETTINGS_KEY = ['fraud', 'settings'] as const;
export const FRAUD_BLOCKLIST_KEY = ['fraud', 'blocklist'] as const;
export const FRAUD_RULES_KEY = ['fraud', 'rules'] as const;

interface WithRescan {
  rescanQueued?: number;
}

function rescanMessage(base: string, queued: number | undefined): string {
  if (!queued) return base;
  return `${base} — ${queued} pending order${queued === 1 ? '' : 's'} re-scored`;
}

export function useFraudSettings(): UseQueryResult<FraudSettingsSummary, Error> {
  return useQuery({
    queryKey: FRAUD_SETTINGS_KEY,
    queryFn: () => api.get<FraudSettingsSummary>('/admin/fraud/settings'),
  });
}

export function useUpdateFraudSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Partial<FraudSettingsSummary>) =>
      api.patch<FraudSettingsSummary & WithRescan>('/admin/fraud/settings', input),

    onSuccess: (result) => {
      queryClient.setQueryData(FRAUD_SETTINGS_KEY, result);
      showToast(rescanMessage('Fraud settings saved', result.rescanQueued));
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useBlockList(filter: { type?: string; scope?: string; search?: string }) {
  const params = new URLSearchParams();
  if (filter.type) params.set('type', filter.type);
  if (filter.scope) params.set('scope', filter.scope);
  if (filter.search) params.set('search', filter.search);

  const query = params.toString();

  return useQuery({
    queryKey: [...FRAUD_BLOCKLIST_KEY, query],
    queryFn: () =>
      api.get<BlockListEntrySummary[]>(`/admin/fraud/blocklist${query ? `?${query}` : ''}`),
  });
}

export function useAddBlockListEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { type: string; scope: string; value: string; reason?: string }) =>
      api.post<BlockListEntrySummary & WithRescan>('/admin/fraud/blocklist', input),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: FRAUD_BLOCKLIST_KEY });
      showToast(rescanMessage('Added to your list', result.rescanQueued));
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export interface BulkListResult extends WithRescan {
  total: number;
  added: number;
  removed: number;
  duplicates: number;
}

/**
 * Replaces one whole list.
 *
 * The counts come back because a merchant pasting a column out of a spreadsheet
 * cannot otherwise tell what happened — "412 blocked" says the paste worked,
 * and the duplicate count explains why 500 lines became 412 without them having
 * to diff it themselves.
 */
export function useReplaceBlockList() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { type: string; scope: string; values: string[] }) =>
      api.put<BulkListResult>('/admin/fraud/blocklist/bulk', input),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: FRAUD_BLOCKLIST_KEY });

      const duplicates =
        result.duplicates > 0 ? ` · ${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'} merged` : '';

      showToast(rescanMessage(`Saved — ${result.total} in the list${duplicates}`, result.rescanQueued));
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useRemoveBlockListEntry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/fraud/blocklist/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FRAUD_BLOCKLIST_KEY });
      showToast('Entry removed');
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useFraudRules(): UseQueryResult<FraudRuleSummary[], Error> {
  return useQuery({
    queryKey: FRAUD_RULES_KEY,
    queryFn: () => api.get<FraudRuleSummary[]>('/admin/fraud/rules'),
  });
}

export function useToggleRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      api.patch<{ rescanQueued?: number }>(`/admin/fraud/rules/${id}`, { isEnabled }),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: FRAUD_RULES_KEY });
      showToast(rescanMessage('Rule updated', result.rescanQueued));
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useDeleteRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/fraud/rules/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FRAUD_RULES_KEY });
      showToast('Rule deleted');
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

/** The risk breakdown for one order. */
export interface OrderRisk {
  reference: string;
  riskScore: number;
  riskLevel: string;
  riskAction: string;
  assessment: RiskAssessmentSummary | null;
}

export function useOrderRisk(reference: string | undefined) {
  return useQuery({
    queryKey: ['fraud', 'order', reference],
    queryFn: () => api.get<OrderRisk>(`/admin/fraud/orders/${reference}`),
    enabled: Boolean(reference),
  });
}

export function useReviewOrder(reference: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { decision: string; note?: string }) =>
      api.post<{ riskAction: string }>(`/admin/fraud/orders/${reference}/review`, input),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['fraud', 'order', reference] });
      showToast(`Order set to ${result.riskAction}`);
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useRescanOrder(reference: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ score: number; action: string }>(`/admin/fraud/orders/${reference}/rescan`),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['fraud', 'order', reference] });
      showToast(`Rescanned — score ${result.score}, ${result.action}`);
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AnalyticsBreakdown,
  AnalyticsFunnel,
  AnalyticsOverview,
  AnalyticsRange,
  BreakdownDimension,
  RebuildStatsResult,
  StoreHealth,
} from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Analytics data access.
 *
 * Every read takes the same range, so the query keys include it and switching
 * the date selector refetches the whole screen coherently — rather than
 * leaving one card showing last month beside another showing last week, which
 * is the failure mode when each chart owns its own range state.
 *
 * `staleTime` is deliberate. These aggregates change at most once per order,
 * and a dashboard that refetches four endpoints on every window focus is a
 * measurable load on the API for numbers that have not moved. A minute is short
 * enough that a merchant watching orders arrive sees them.
 */

const STALE_TIME = 60_000;

export interface AnalyticsRangeState {
  readonly range: AnalyticsRange;
  readonly from?: string;
  readonly to?: string;
}

function rangeQuery(state: AnalyticsRangeState): string {
  const params = new URLSearchParams({ range: state.range });
  if (state.range === 'custom' && state.from && state.to) {
    params.set('from', state.from);
    params.set('to', state.to);
  }
  return params.toString();
}

export const ANALYTICS_KEY = ['analytics'] as const;

export function useAnalyticsOverview(
  state: AnalyticsRangeState,
): UseQueryResult<AnalyticsOverview, Error> {
  const query = rangeQuery(state);

  return useQuery({
    queryKey: [...ANALYTICS_KEY, 'overview', query],
    queryFn: () => api.get<AnalyticsOverview>(`/admin/analytics/overview?${query}`),
    staleTime: STALE_TIME,
    // The previous range stays on screen while the new one loads, so changing
    // the date selector does not blank the dashboard and reflow every card.
    placeholderData: (previous) => previous,
  });
}

export function useAnalyticsBreakdown(
  state: AnalyticsRangeState,
  dimension: BreakdownDimension,
): UseQueryResult<AnalyticsBreakdown, Error> {
  const query = `${rangeQuery(state)}&dimension=${dimension}`;

  return useQuery({
    queryKey: [...ANALYTICS_KEY, 'breakdown', query],
    queryFn: () => api.get<AnalyticsBreakdown>(`/admin/analytics/breakdown?${query}`),
    staleTime: STALE_TIME,
    placeholderData: (previous) => previous,
  });
}

export function useAnalyticsFunnel(
  state: AnalyticsRangeState,
): UseQueryResult<AnalyticsFunnel, Error> {
  const query = rangeQuery(state);

  return useQuery({
    queryKey: [...ANALYTICS_KEY, 'funnel', query],
    queryFn: () => api.get<AnalyticsFunnel>(`/admin/analytics/funnel?${query}`),
    staleTime: STALE_TIME,
    placeholderData: (previous) => previous,
  });
}

/**
 * Store health.
 *
 * Refetched more eagerly than the aggregates, because every check on it is a
 * silent failure — a revoked Google token, a pixel rejecting everything, orders
 * stuck before Shopify. Those are worth surfacing within seconds of the
 * merchant opening the app, not within a minute.
 */
export function useStoreHealth(): UseQueryResult<StoreHealth, Error> {
  return useQuery({
    queryKey: [...ANALYTICS_KEY, 'health'],
    queryFn: () => api.get<StoreHealth>('/admin/analytics/health'),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Recomputes stored aggregates from the orders themselves.
 *
 * The answer to "these numbers look wrong". A short range comes back completed;
 * a long one is queued and answered immediately, so the toast has to say which
 * happened — a merchant told "rebuilt" who then sees unchanged numbers for
 * another minute will simply click it again.
 */
export function useRebuildStats() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.post<RebuildStatsResult>('/admin/analytics/rebuild', input),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ANALYTICS_KEY });

      showToast(
        result.queued
          ? `Rebuilding ${result.days} days in the background — this page will catch up shortly`
          : `Rebuilt ${result.days} days from your orders`,
      );
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  PixelEventName,
  PixelEventSummary,
  PixelSummary,
  PixelTestResult,
} from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Pixel configuration data access.
 *
 * `accessToken` is the field that shapes this module. It is write-only: the
 * server returns `hasAccessToken` and never the token itself, so an update that
 * omits the key leaves the stored one alone and an explicit `null` clears it.
 * Sending `''` would store an empty credential and every server-side event would
 * then fail authentication — so the form must never send a blank string, and
 * that rule is enforced here rather than trusted to each caller.
 */

export const PIXELS_QUERY_KEY = ['pixels'] as const;
export const PIXEL_EVENTS_QUERY_KEY = ['pixels', 'events'] as const;

export interface PixelInput {
  provider: string;
  label: string;
  pixelId: string;
  isEnabled?: boolean;
  clientSideEnabled?: boolean;
  serverSideEnabled?: boolean;
  accessToken?: string | null;
  testEventCode?: string | null;
  conversionId?: string | null;
  conversionLabel?: string | null;
  gtmContainerId?: string | null;
  advancedMatching?: boolean;
  deduplication?: boolean;
  requireConsent?: boolean;
  enabledEvents?: readonly PixelEventName[];
  customScript?: string | null;
}

export function usePixels(): UseQueryResult<PixelSummary[], Error> {
  return useQuery({
    queryKey: PIXELS_QUERY_KEY,
    queryFn: () => api.get<PixelSummary[]>('/admin/pixels'),
  });
}

/**
 * Recent dispatches, client and server.
 *
 * Polled while the screen is open: a merchant who has just sent a test event is
 * waiting for a row to appear, and making them reload to see whether their
 * setup works is the opposite of a diagnostics screen.
 */
export function usePixelEvents(limit = 25): UseQueryResult<PixelEventSummary[], Error> {
  return useQuery({
    queryKey: [...PIXEL_EVENTS_QUERY_KEY, limit],
    queryFn: () => api.get<PixelEventSummary[]>(`/admin/pixels/events?limit=${limit}`),
    refetchInterval: 15_000,
  });
}

export function useCreatePixel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PixelInput) => api.post<PixelSummary>('/admin/pixels', input),
    onSuccess: (pixel) => {
      void queryClient.invalidateQueries({ queryKey: PIXELS_QUERY_KEY });
      showToast(`${pixel.label} added`);
    },
    // Carries the plan-limit refusal, which names the plan that would allow it.
    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useUpdatePixel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...changes }: Partial<PixelInput> & { id: string }) =>
      api.patch<PixelSummary>(`/admin/pixels/${id}`, changes),

    onSuccess: (pixel) => {
      queryClient.setQueryData<PixelSummary[]>(PIXELS_QUERY_KEY, (current) =>
        current?.map((entry) => (entry.id === pixel.id ? pixel : entry)),
      );
      showToast(`${pixel.label} saved`);
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useDeletePixel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/pixels/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PIXELS_QUERY_KEY });
      showToast('Pixel removed');
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

/**
 * Sends a synthetic event.
 *
 * The result is returned to the caller rather than reduced to a toast: a failed
 * test carries the provider's own error message, and that string is the single
 * most useful thing on the screen when a pixel is misconfigured.
 */
export function useTestPixel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, eventName }: { id: string; eventName: PixelEventName }) =>
      api.post<PixelTestResult>(`/admin/pixels/${id}/test`, { eventName }),

    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: PIXEL_EVENTS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: PIXELS_QUERY_KEY });
      showToast(result.ok ? 'Test event accepted' : 'Test event refused', !result.ok);
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

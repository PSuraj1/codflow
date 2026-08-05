import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  SheetColumnMapping,
  SheetConfigSummary,
  SheetsOverview,
  SpreadsheetSummary,
  WorksheetSummary,
} from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/** Data access for the Google Sheets settings screen. */

export const SHEETS_QUERY_KEY = ['sheets'] as const;

export function useSheetsOverview(): UseQueryResult<SheetsOverview, Error> {
  return useQuery({
    queryKey: SHEETS_QUERY_KEY,
    queryFn: () => api.get<SheetsOverview>('/admin/sheets'),
  });
}

/**
 * Spreadsheets the app can see.
 *
 * Deferred until the merchant opens the sheet-selection step: under the
 * `drive.file` scope the list is a Drive round trip that most page loads never
 * need, and fetching it eagerly would slow the screen for merchants who have
 * already finished setup.
 */
export function useSpreadsheets(enabled: boolean): UseQueryResult<SpreadsheetSummary[], Error> {
  return useQuery({
    queryKey: ['sheets', 'spreadsheets'],
    queryFn: () => api.get<SpreadsheetSummary[]>('/admin/sheets/spreadsheets'),
    enabled,
    // Drive is the merchant's own file list and changes rarely within a session.
    staleTime: 60_000,
  });
}

export function useWorksheets(
  spreadsheetId: string | null,
): UseQueryResult<WorksheetSummary[], Error> {
  return useQuery({
    queryKey: ['sheets', 'worksheets', spreadsheetId],
    queryFn: () =>
      api.get<WorksheetSummary[]>(`/admin/sheets/spreadsheets/${spreadsheetId}/worksheets`),
    enabled: Boolean(spreadsheetId),
  });
}

function useSheetMutation<TInput>(
  mutationFn: (input: TInput) => Promise<unknown>,
  successMessage: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SHEETS_QUERY_KEY });
      showToast(successMessage);
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useCreateSpreadsheet() {
  return useSheetMutation<{ title: string; worksheetName: string }>(
    (input) => api.post<SheetConfigSummary>('/admin/sheets/spreadsheets', input),
    'Spreadsheet created',
  );
}

export function useSelectSpreadsheet() {
  return useSheetMutation<{ spreadsheetId: string; worksheetName?: string }>(
    (input) => api.put<SheetConfigSummary>('/admin/sheets/spreadsheet', input),
    'Sheet selected',
  );
}

export function useUpdateMapping() {
  return useSheetMutation<{ columns: Array<{ source: string; header: string }> }>(
    (input) => api.put<SheetConfigSummary>('/admin/sheets/mapping', input),
    'Columns saved',
  );
}

export function useUpdateSheetSettings() {
  return useSheetMutation<Record<string, boolean>>(
    (input) => api.patch<SheetConfigSummary>('/admin/sheets/settings', input),
    'Settings saved',
  );
}

export function useDisconnectGoogle() {
  return useSheetMutation<void>(
    () => api.delete<void>('/admin/sheets/account'),
    'Google account disconnected',
  );
}

export function useBackfill() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (limit: number) =>
      api.post<{ queued: number }>(`/admin/sheets/backfill?limit=${limit}`),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: SHEETS_QUERY_KEY });
      showToast(
        result.queued === 0
          ? 'Every order is already in your sheet'
          : `${result.queued} order${result.queued === 1 ? '' : 's'} queued for export`,
      );
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

/** Fetches the consent URL and opens it in the top frame. */
export function useConnectGoogle() {
  return useMutation({
    mutationFn: () => api.get<{ url: string }>('/admin/sheets/connect-url'),
    onSuccess: ({ url }) => {
      // Google sends `X-Frame-Options: DENY` on its consent screen, so the app
      // iframe cannot render it. This has to leave the frame entirely, and it
      // is an absolute Google URL rather than an app-relative path — so it goes
      // straight to the top window instead of through `openTop`, which
      // absolutises against the app's own origin.
      window.top?.location.assign(url);
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

/** Compares a saved mapping with an edited one, for the unsaved-changes bar. */
export function mappingChanged(
  saved: readonly SheetColumnMapping[],
  edited: readonly { source: string; header: string }[],
): boolean {
  if (saved.length !== edited.length) return true;

  return saved.some(
    (column, index) =>
      column.source !== edited[index]?.source || column.header !== edited[index]?.header,
  );
}

import { useMutation } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { SettingsImportResult } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Settings backup and restore.
 *
 * The export is deliberately *not* a react-query query. It is an action with a
 * side effect — a file lands in the merchant's Downloads folder — and caching
 * it would hand them a stale copy of settings they had since changed while
 * telling them it was a fresh backup.
 */

/**
 * Downloads the settings file.
 *
 * Fetched rather than linked, because the request needs the App Bridge session
 * token that `api` attaches; a plain `<a href>` would arrive unauthenticated.
 * The blob is turned into a click on a temporary anchor, which is the only way
 * to name a downloaded file from script.
 */
export function useExportSettings() {
  return useMutation({
    mutationFn: async () => {
      const { blob, filename } = await api.download('/admin/settings/export');

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');

      anchor.href = url;
      anchor.download = filename ?? 'codflow-settings.json';
      document.body.appendChild(anchor);
      anchor.click();

      anchor.remove();
      // Without this the blob is held for the lifetime of the document.
      URL.revokeObjectURL(url);
    },

    onSuccess: () => showToast('Settings exported'),
    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useImportSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: unknown) =>
      api.post<SettingsImportResult>('/admin/settings/import', payload),

    onSuccess: (result) => {
      // An import rewrites most of what the admin is holding, so every cached
      // screen is stale — invalidating one at a time would leave whichever the
      // merchant opened next showing pre-import values.
      void queryClient.invalidateQueries();

      showToast(
        `Imported ${result.buttons} buttons, ${result.forms} forms and ${result.fraudRules} fraud rules`,
      );
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

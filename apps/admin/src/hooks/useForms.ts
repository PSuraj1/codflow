import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { FormDefinition, FormFieldDefinition } from '@codflow/shared';
import { api } from '../lib/apiClient';
import { showToast } from '../lib/appBridge';

/**
 * Form builder data access.
 *
 * The field list is saved as a whole rather than field by field. That is not
 * laziness — a single drag changes the position of every field between the
 * source and the destination, and sending those as individual requests would be
 * a burst that can interleave and land out of order, leaving the merchant with
 * an arrangement they never made.
 */

export const FORMS_QUERY_KEY = ['forms'] as const;

export function formQueryKey(formId: string) {
  return ['forms', formId] as const;
}

export function useForms(): UseQueryResult<FormDefinition[], Error> {
  return useQuery({
    queryKey: FORMS_QUERY_KEY,
    queryFn: () => api.get<FormDefinition[]>('/admin/forms'),
  });
}

export function useForm(formId: string | undefined): UseQueryResult<FormDefinition, Error> {
  return useQuery({
    queryKey: formQueryKey(formId ?? ''),
    queryFn: () => api.get<FormDefinition>(`/admin/forms/${formId}`),
    enabled: Boolean(formId),
  });
}

/** Field shape the API accepts. Drops server-owned properties. */
export interface FieldInput {
  id?: string;
  key: string;
  type: FormFieldDefinition['type'];
  label: string;
  placeholder?: string | null;
  helpText?: string | null;
  enabled: boolean;
  hidden: boolean;
  defaultValue?: string | null;
  validation: FormFieldDefinition['validation'];
  options: FormFieldDefinition['options'];
  conditional?: FormFieldDefinition['conditional'];
  columnWidth: number;
  cssClass?: string | null;
  translations: FormFieldDefinition['translations'];
}

/** Strips the properties the server assigns, so a round-tripped field re-saves cleanly. */
export function toFieldInput(field: FormFieldDefinition): FieldInput {
  return {
    id: field.id,
    key: field.key,
    type: field.type,
    label: field.label,
    placeholder: field.placeholder,
    helpText: field.helpText,
    enabled: field.enabled,
    hidden: field.hidden,
    defaultValue: field.defaultValue,
    validation: field.validation,
    options: field.options,
    conditional: field.conditional,
    columnWidth: field.columnWidth,
    cssClass: field.cssClass,
    translations: field.translations,
  };
}

export function useSaveFields(formId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (fields: FieldInput[]) =>
      api.put<FormDefinition>(`/admin/forms/${formId}/fields`, { fields }),

    onSuccess: (form) => {
      // Seed the cache from the response rather than refetching: the server
      // returns the saved form, so a round trip would only re-fetch what we
      // already have and make the save feel slower than it was.
      queryClient.setQueryData(formQueryKey(formId), form);
      void queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
      showToast('Form saved');
    },

    onError: (error: Error) => {
      showToast(error.message, true);
    },
  });
}

export function useUpdateForm(formId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Partial<FormDefinition>) =>
      api.patch<FormDefinition>(`/admin/forms/${formId}`, input),

    onSuccess: (form) => {
      queryClient.setQueryData(formQueryKey(formId), form);
      void queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
      showToast('Form updated');
    },

    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useCreateForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string }) => api.post<FormDefinition>('/admin/forms', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
      showToast('Form created');
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useDuplicateForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (formId: string) => api.post<FormDefinition>(`/admin/forms/${formId}/duplicate`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
      showToast('Form duplicated');
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

export function useDeleteForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (formId: string) => api.delete<void>(`/admin/forms/${formId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FORMS_QUERY_KEY });
      showToast('Form deleted');
    },
    onError: (error: Error) => showToast(error.message, true),
  });
}

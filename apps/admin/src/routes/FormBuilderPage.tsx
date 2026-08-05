import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Popover,
  ActionList,
  Banner,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { PlusIcon } from '@shopify/polaris-icons';
import type { FormFieldDefinition } from '@codflow/shared';
import { useForm, useSaveFields, useUpdateForm, toFieldInput } from '../hooks/useForms';
import { useSession } from '../hooks/useSession';
import { ApiError } from '../lib/apiClient';
import { FieldRow } from '../components/builder/FieldRow';
import { FieldEditor } from '../components/builder/FieldEditor';
import { FormPreview } from '../components/builder/FormPreview';
import { FIELD_CATALOGUE, blankField } from '../components/builder/fieldCatalogue';
import { FormCopyEditor, type FormCopy } from '../components/builder/FormCopyEditor';
import { TranslationsPanel } from '../components/builder/TranslationsPanel';
import { SubmitButtonRow } from '../components/builder/SubmitButtonRow';
import { SaveBar } from '../components/SaveBar';

/**
 * Sentinel for the submit row's place in the selection model.
 *
 * The row is not a field and has no id of its own, but it shares the one
 * right-hand panel with the fields — so it needs a value `selectedId` can hold
 * that no field will ever collide with.
 */
const SUBMIT_ROW_ID = '__submit__';

/**
 * The drag-and-drop form builder.
 *
 * All edits are local until the merchant saves. That is a deliberate choice
 * over autosave: a COD form is the merchant's live conversion path, and
 * persisting every keystroke would publish half-finished states to shoppers —
 * a field renamed mid-thought, a required flag toggled while deciding. The
 * contextual save bar makes the unsaved state unmistakable, which is the
 * pattern Shopify's own admin uses for exactly this reason.
 */
export function FormBuilderPage() {
  const { formId } = useParams<{ formId: string }>();
  const navigate = useNavigate();

  const { data: session } = useSession();
  const { data: form, isPending, error } = useForm(formId);
  const saveFields = useSaveFields(formId ?? '');
  const updateForm = useUpdateForm(formId ?? '');

  const [fields, setFields] = useState<FormFieldDefinition[]>([]);
  const [copy, setCopy] = useState<FormCopy | null>(null);
  const [translations, setTranslations] = useState<Record<string, Record<string, string>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seeds local state once the form arrives, and re-seeds after a save returns
  // server-assigned ids for newly created fields.
  useEffect(() => {
    if (form) {
      setFields([...form.fields]);
      setCopy({
        headingText: form.headingText,
        subheadingText: form.subheadingText,
        submitButtonText: form.submitButtonText,
        successMessage: form.successMessage,
      });
      setTranslations(form.translations as Record<string, Record<string, string>>);
      setDirty(false);
    }
  }, [form]);

  /**
   * Tracked separately from the fields, because they are separate endpoints —
   * the wording is a `PATCH` on the form and the fields are a wholesale
   * replace. One save bar covers both; only what changed is sent.
   */
  const copyDirty = useMemo(() => {
    if (!form || !copy) return false;

    return (
      copy.headingText !== form.headingText ||
      copy.subheadingText !== form.subheadingText ||
      copy.submitButtonText !== form.submitButtonText ||
      copy.successMessage !== form.successMessage ||
      // Same `PATCH` as the wording, so it rides along rather than needing its
      // own dirty flag and its own save.
      JSON.stringify(translations) !== JSON.stringify(form.translations)
    );
  }, [copy, form, translations]);

  const selected = useMemo(
    () => fields.find((field) => field.id === selectedId) ?? null,
    [fields, selectedId],
  );

  /**
   * Languages worth translating into.
   *
   * Taken from the shop's published locales, which `shop/service.syncLocales`
   * adopts from the storefront at install — a merchant should not have to
   * discover a second language list here to match the one they already keep in
   * Shopify. The default is excluded because it *is* the source text.
   */
  const defaultLocale = session?.preferences.defaultLocale ?? 'EN';

  const translatableLocales = useMemo(
    () => (session?.preferences.enabledLocales ?? []).filter((entry) => entry !== defaultLocale),
    [defaultLocale, session],
  );

  const mutate = useCallback((next: FormFieldDefinition[]) => {
    setFields(next);
    setDirty(true);
    setSaveError(null);
  }, []);

  const handleMove = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= fields.length) return;

      const next = [...fields];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      mutate(next);
    },
    [fields, mutate],
  );

  const handleDelete = useCallback(
    (id: string) => {
      mutate(fields.filter((field) => field.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [fields, mutate, selectedId],
  );

  const handleToggleEnabled = useCallback(
    (id: string) => {
      mutate(
        fields.map((field) => (field.id === id ? { ...field, enabled: !field.enabled } : field)),
      );
    },
    [fields, mutate],
  );

  const handleFieldChange = useCallback(
    (updated: FormFieldDefinition) => {
      mutate(fields.map((field) => (field.id === updated.id ? updated : field)));
    },
    [fields, mutate],
  );

  const handleAdd = useCallback(
    (type: FormFieldDefinition['type']) => {
      const field = blankField(
        type,
        fields.map((existing) => existing.key),
      );
      mutate([...fields, field]);
      setSelectedId(field.id);
      setAddOpen(false);
    },
    [fields, mutate],
  );

  const handleSave = useCallback(() => {
    setSaveError(null);

    // Sent only when it changed, so reordering a field does not rewrite the
    // shop's wording — and an unchanged form is not PATCHed at all.
    if (copyDirty && copy) {
      updateForm.mutate({ ...copy, translations });
    }

    if (!dirty) return;

    saveFields.mutate(
      fields.map((field) => {
        const input = toFieldInput(field);
        // A client-generated id means "create this". Sending it would make the
        // server look for a row that does not exist.
        return field.id.startsWith('new-') ? { ...input, id: undefined } : input;
      }),
      {
        onError: (mutationError: Error) => {
          if (mutationError instanceof ApiError) {
            const details = mutationError.body.details as
              | { fields?: Record<string, string[]> | string[] }
              | undefined;

            const messages = Array.isArray(details?.fields)
              ? details.fields
              : Object.values(details?.fields ?? {}).flat();

            setSaveError(messages.length > 0 ? messages.join(' ') : mutationError.message);
            return;
          }
          setSaveError(mutationError.message);
        },
      },
    );
  }, [copy, copyDirty, dirty, fields, saveFields, translations, updateForm]);

  const handleDiscard = useCallback(() => {
    if (form) {
      setFields([...form.fields]);
      setCopy({
        headingText: form.headingText,
        subheadingText: form.subheadingText,
        submitButtonText: form.submitButtonText,
        successMessage: form.successMessage,
      });
      setTranslations(form.translations as Record<string, Record<string, string>>);
    }
    setDirty(false);
    setSaveError(null);
  }, [form]);

  if (isPending) {
    return (
      <Page title="Form builder">
        <Card>
          <SkeletonBodyText lines={8} />
        </Card>
      </Page>
    );
  }

  if (error || !form) {
    return (
      <Page title="Form builder" backAction={{ content: 'Forms', onAction: () => navigate('/forms') }}>
        <Banner tone="critical" title="Could not load this form">
          <p>{error?.message ?? 'The form could not be found.'}</p>
        </Banner>
      </Page>
    );
  }

  // A field cannot depend on itself, so the selected one is excluded from its
  // own condition source list.
  const siblingKeys = fields
    .filter((field) => field.id !== selectedId && field.enabled)
    .map((field) => ({ key: field.key, label: field.label }));

  return (
    <Page
      title={form.name}
      titleMetadata={form.active ? <Badge tone="success">Active</Badge> : <Badge>Draft</Badge>}
      backAction={{ content: 'Forms', onAction: () => navigate('/forms') }}
      secondaryActions={
        form.active
          ? []
          : [
              {
                content: 'Make active',
                onAction: () => updateForm.mutate({ active: true }),
                loading: updateForm.isPending,
              },
            ]
      }
    >
      <SaveBar
        id="codflow-save-form-builder"
        dirty={dirty || copyDirty}
        loading={saveFields.isPending || updateForm.isPending}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {saveError ? (
              <Banner tone="critical" title="This form could not be saved">
                <p>{saveError}</p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Fields
                  </Text>

                  <Popover
                    active={addOpen}
                    activator={
                      <Button icon={PlusIcon} onClick={() => setAddOpen((open) => !open)}>
                        Add field
                      </Button>
                    }
                    onClose={() => setAddOpen(false)}
                  >
                    <ActionList
                      actionRole="menuitem"
                      items={FIELD_CATALOGUE.map((entry) => ({
                        content: entry.label,
                        helpText: entry.description,
                        onAction: () => handleAdd(entry.type),
                      }))}
                    />
                  </Popover>
                </InlineStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  Drag to reorder, or use the arrows — both do the same thing, and the arrows work
                  with a keyboard.
                </Text>

                <BlockStack gap="200">
                  {fields.map((field, index) => (
                    <FieldRow
                      key={field.id}
                      field={field}
                      index={index}
                      total={fields.length}
                      isSelected={field.id === selectedId}
                      onSelect={setSelectedId}
                      onMove={handleMove}
                      onDelete={handleDelete}
                      onToggleEnabled={handleToggleEnabled}
                    />
                  ))}

                  {/*
                    Last, always. It is where the button renders for a shopper,
                    and the list looked truncated without it.
                  */}
                  {copy ? (
                    <SubmitButtonRow
                      label={copy.submitButtonText}
                      isSelected={selectedId === SUBMIT_ROW_ID}
                      onSelect={() => setSelectedId(SUBMIT_ROW_ID)}
                    />
                  ) : null}
                </BlockStack>
              </BlockStack>
            </Card>

            <FormPreview fields={fields} submitButtonText={copy?.submitButtonText} />

            {copy ? (
              <TranslationsPanel
                locales={translatableLocales}
                defaultLocale={defaultLocale}
                copy={copy}
                translations={translations}
                onTranslationsChange={(next) => {
                  setTranslations(next);
                  setSaveError(null);
                }}
                fields={fields}
                onFieldChange={handleFieldChange}
              />
            ) : null}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            {selectedId === SUBMIT_ROW_ID && copy ? (
              <FormCopyEditor
                copy={copy}
                onChange={(next) => {
                  setCopy(next);
                  setSaveError(null);
                }}
              />
            ) : selected ? (
              <FieldEditor
                field={selected}
                siblingKeys={siblingKeys}
                onChange={handleFieldChange}
              />
            ) : (
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Field settings
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Select a field to edit its label, validation and visibility rules.
                </Text>
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

import { useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Divider,
  InlineStack,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  LOCALE_LABELS,
  PRESENTATIONAL_TYPES,
  type FormFieldDefinition,
  type Locale,
} from '@codflow/shared';
import type { FormCopy } from './FormCopyEditor';

/**
 * Translations for the COD form.
 *
 * Everything under this component has existed since the form was built: the
 * `translations` columns, `localizeForm`, the storefront sending
 * `request.locale.iso_code` on every fetch, and the submission path localizing
 * again before it validates. What was missing was any way to *write* a
 * translation, so every shop's form rendered in English whatever language the
 * shopper was browsing in.
 *
 * The source string is shown beside each input rather than only as a
 * placeholder. A translator working down a list needs to see what they are
 * translating even after they have typed something, and a placeholder
 * disappears exactly then.
 *
 * Empty means "fall back", not "blank". `localizeForm` uses `??`, so a missing
 * or empty translation renders the default text — which is why nothing here
 * needs a "reset" control.
 */

interface Props {
  /** Locales the shop publishes, minus the default. Empty hides the panel. */
  locales: readonly Locale[];
  defaultLocale: Locale;
  copy: FormCopy;
  /** Form-level: locale -> field name -> text. */
  translations: Record<string, Record<string, string>>;
  onTranslationsChange: (next: Record<string, Record<string, string>>) => void;
  fields: readonly FormFieldDefinition[];
  onFieldChange: (field: FormFieldDefinition) => void;
}

/** The four form-level strings, in the order a shopper meets them. */
const COPY_KEYS = [
  { key: 'headingText', label: 'Heading' },
  { key: 'subheadingText', label: 'Sub-heading' },
  { key: 'submitButtonText', label: 'Button text' },
  { key: 'successMessage', label: 'Message after ordering' },
] as const;

export function TranslationsPanel({
  locales,
  defaultLocale,
  copy,
  translations,
  onTranslationsChange,
  fields,
  onFieldChange,
}: Props) {
  const [locale, setLocale] = useState<string>(locales[0] ?? '');

  if (locales.length === 0) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            Translations
          </Text>
          <Banner tone="info">
            <p>
              Your store publishes one language, so there is nothing to translate. CODkar follows
              the languages you publish in Shopify — add one there and it appears here.
            </p>
          </Banner>
        </BlockStack>
      </Card>
    );
  }

  const language = locale.toLowerCase();
  const forLocale = translations[language] ?? {};

  const setCopyValue = (key: string, value: string) => {
    onTranslationsChange({
      ...translations,
      [language]: { ...forLocale, [key]: value },
    });
  };

  const setFieldValue = (
    field: FormFieldDefinition,
    key: 'label' | 'placeholder' | 'helpText',
    value: string,
  ) => {
    onFieldChange({
      ...field,
      translations: {
        ...field.translations,
        [language]: { ...(field.translations[language] ?? {}), [key]: value },
      },
    });
  };

  /** How many strings this locale has filled in, out of what it could. */
  const translatable = fields.filter(
    (field) => field.enabled && !PRESENTATIONAL_TYPES.includes(field.type),
  );

  const done =
    COPY_KEYS.filter(({ key }) => (forLocale[key] ?? '').trim() !== '').length +
    translatable.filter((field) => (field.translations[language]?.label ?? '').trim() !== '').length;

  const total = COPY_KEYS.length + translatable.length;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Translations
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Anything left empty falls back to the {LOCALE_LABELS[defaultLocale]} text, so a
              partial translation is safe to save.
            </Text>
          </BlockStack>

          <InlineStack gap="200" blockAlign="center">
            <Badge tone={done === total ? 'success' : undefined}>{`${done} of ${total}`}</Badge>
            <Box minWidth="180px">
              <Select
                label="Language"
                labelHidden
                options={locales.map((entry) => ({
                  label: LOCALE_LABELS[entry] ?? entry,
                  value: entry,
                }))}
                value={locale}
                onChange={setLocale}
              />
            </Box>
          </InlineStack>
        </InlineStack>

        <Divider />

        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Wording
          </Text>

          {COPY_KEYS.map(({ key, label }) => {
            const source = copy[key as keyof FormCopy];
            if (key === 'subheadingText' && !source) return null;

            return (
              <TextField
                key={key}
                label={label}
                value={forLocale[key] ?? ''}
                onChange={(value) => setCopyValue(key, value)}
                autoComplete="off"
                helpText={`${LOCALE_LABELS[defaultLocale]}: ${source ?? ''}`}
              />
            );
          })}
        </BlockStack>

        <Divider />

        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Fields
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Only the words a shopper reads. A field&rsquo;s key and validation rules are the same in
            every language.
          </Text>

          {translatable.map((field) => {
            const overrides = field.translations[language] ?? {};

            return (
              <Box
                key={field.id}
                padding="300"
                borderRadius="200"
                borderWidth="025"
                borderColor="border"
              >
                <BlockStack gap="200">
                  <TextField
                    label="Label"
                    value={overrides.label ?? ''}
                    onChange={(value) => setFieldValue(field, 'label', value)}
                    autoComplete="off"
                    helpText={`${LOCALE_LABELS[defaultLocale]}: ${field.label}`}
                  />

                  {field.placeholder ? (
                    <TextField
                      label="Placeholder"
                      value={overrides.placeholder ?? ''}
                      onChange={(value) => setFieldValue(field, 'placeholder', value)}
                      autoComplete="off"
                      helpText={`${LOCALE_LABELS[defaultLocale]}: ${field.placeholder}`}
                    />
                  ) : null}

                  {field.helpText ? (
                    <TextField
                      label="Help text"
                      value={overrides.helpText ?? ''}
                      onChange={(value) => setFieldValue(field, 'helpText', value)}
                      autoComplete="off"
                      helpText={`${LOCALE_LABELS[defaultLocale]}: ${field.helpText}`}
                    />
                  ) : null}
                </BlockStack>
              </Box>
            );
          })}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

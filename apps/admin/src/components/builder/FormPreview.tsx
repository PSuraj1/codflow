import { useMemo, useState } from 'react';
import { BlockStack, Box, Button, Card, Checkbox, Select, Text, TextField } from '@shopify/polaris';
import {
  PRESENTATIONAL_TYPES,
  resolveVisibility,
  validateField,
  type FormFieldDefinition,
  type FormValues,
} from '@codflow/shared';

/**
 * Live preview of the form being built.
 *
 * It runs the **real** shared validation and visibility engine — the same
 * functions the storefront and the API run. That is the point of the preview:
 * a merchant building a conditional rule can type a value and watch the
 * dependent field appear, and if it does not appear here it will not appear for
 * a shopper either.
 *
 * A mock preview that only approximated those rules would be worse than none,
 * because it would give merchants confidence in a form that behaves
 * differently in production.
 */

interface Props {
  fields: readonly FormFieldDefinition[];
  /** The form's own submit copy. The button renders last, as it does on a storefront. */
  submitButtonText?: string;
}

export function FormPreview({ fields, submitButtonText }: Props) {
  const [values, setValues] = useState<FormValues>({});

  const visibility = useMemo(() => resolveVisibility(fields, values), [fields, values]);

  const errors = useMemo(() => {
    const result: Record<string, string> = {};

    for (const field of fields) {
      // Only validate what is both visible and answered — showing "required" on
      // an untouched preview would make every form look broken.
      if (!visibility[field.key]) continue;
      if (values[field.key] === undefined) continue;

      const error = validateField(field, values[field.key] ?? null);
      if (error) result[field.key] = error.message;
    }

    return result;
  }, [fields, values, visibility]);

  const setValue = (key: string, value: FormValues[string]) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Preview
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Type into the fields to see your conditions and validation rules behave exactly as they
          will on your storefront.
        </Text>

        <Box
          background="bg-surface-secondary"
          padding="400"
          borderRadius="200"
        >
          <BlockStack gap="300">
            {fields.map((field) => {
              if (!field.enabled) return null;
              if (!visibility[field.key]) return null;
              if (field.hidden || field.type === 'HIDDEN') return null;

              if (field.type === 'HEADING') {
                return (
                  <Text key={field.id} as="h4" variant="headingSm">
                    {field.label}
                  </Text>
                );
              }

              if (field.type === 'PARAGRAPH') {
                return (
                  <Text key={field.id} as="p" variant="bodySm" tone="subdued">
                    {field.helpText ?? field.label}
                  </Text>
                );
              }

              if (field.type === 'DIVIDER') {
                return (
                  <Box
                    key={field.id}
                    borderBlockStartWidth="025"
                    borderColor="border"
                    paddingBlockStart="200"
                  />
                );
              }

              if (PRESENTATIONAL_TYPES.includes(field.type)) return null;

              const common = {
                label: field.label,
                error: errors[field.key],
                helpText: field.helpText ?? undefined,
                requiredIndicator: field.validation.required,
              };

              if (field.type === 'CHECKBOX' || field.type === 'CONSENT') {
                return (
                  <Checkbox
                    key={field.id}
                    {...common}
                    checked={values[field.key] === true}
                    onChange={(checked) => setValue(field.key, checked)}
                  />
                );
              }

              if (
                field.type === 'SELECT' ||
                field.type === 'RADIO' ||
                field.type === 'COUNTRY' ||
                field.type === 'STATE'
              ) {
                return (
                  <Select
                    key={field.id}
                    {...common}
                    options={[
                      { label: field.placeholder ?? 'Choose…', value: '' },
                      ...field.options.map((option) => ({
                        label: option.label,
                        value: option.value,
                      })),
                    ]}
                    value={String(values[field.key] ?? '')}
                    onChange={(value) => setValue(field.key, value)}
                  />
                );
              }

              return (
                <TextField
                  key={field.id}
                  {...common}
                  type={
                    field.type === 'NUMBER' || field.type === 'QUANTITY'
                      ? 'number'
                      : field.type === 'EMAIL'
                        ? 'email'
                        : field.type === 'PHONE'
                          ? 'tel'
                          : field.type === 'DATE'
                            ? 'date'
                            : 'text'
                  }
                  multiline={field.type === 'TEXTAREA' ? 3 : undefined}
                  placeholder={field.placeholder ?? undefined}
                  value={String(values[field.key] ?? '')}
                  onChange={(value) => setValue(field.key, value)}
                  autoComplete="off"
                />
              );
            })}

            {/*
              Inert, and last — where the storefront puts it. Submitting here
              would create nothing, and a preview that looked like it might is
              worse than one that plainly does not. On a real storefront its
              colours come from the shop's branding rather than from Polaris.
            */}
            {submitButtonText !== undefined ? (
              <Button variant="primary" fullWidth disabled>
                {submitButtonText}
              </Button>
            ) : null}
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}

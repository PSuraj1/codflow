import { useCallback } from 'react';
import {
  BlockStack,
  Box,
  Button,
  Checkbox,
  Divider,
  InlineStack,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import { DeleteIcon, PlusIcon } from '@shopify/polaris-icons';
import {
  ConditionOperator,
  UNARY_OPERATORS,
  type FieldOption,
  type FormFieldDefinition,
} from '@codflow/shared';
import { fieldMeta } from './fieldCatalogue';

/**
 * Settings panel for the selected field.
 *
 * Two rules govern what is editable here, and both come from the server, which
 * enforces them independently:
 *
 *  - A built-in field's **key** and **type** are locked. The order pipeline
 *    reads them by key and assumes their type, so renaming `phone` to `mobile`
 *    would break order creation rather than just the form.
 *  - A presentational field cannot be required. It carries no value, so a
 *    `required` rule on one makes the form impossible to submit.
 *
 * Disabling the inputs rather than hiding them is deliberate: a merchant who
 * cannot find the key field assumes it is a bug, while a disabled field with an
 * explanation answers the question before it is asked.
 */

interface Props {
  field: FormFieldDefinition;
  /** Every other field's key, for the conditional rule's source dropdown. */
  siblingKeys: readonly { key: string; label: string }[];
  onChange: (field: FormFieldDefinition) => void;
}

const OPERATOR_LABELS: Record<string, string> = {
  [ConditionOperator.EQUALS]: 'is exactly',
  [ConditionOperator.NOT_EQUALS]: 'is not',
  [ConditionOperator.CONTAINS]: 'contains',
  [ConditionOperator.NOT_CONTAINS]: 'does not contain',
  [ConditionOperator.IN]: 'is one of',
  [ConditionOperator.NOT_IN]: 'is not one of',
  [ConditionOperator.GREATER_THAN]: 'is greater than',
  [ConditionOperator.LESS_THAN]: 'is less than',
  [ConditionOperator.GREATER_OR_EQUAL]: 'is at least',
  [ConditionOperator.LESS_OR_EQUAL]: 'is at most',
  [ConditionOperator.IS_EMPTY]: 'is empty',
  [ConditionOperator.IS_NOT_EMPTY]: 'is not empty',
};

export function FieldEditor({ field, siblingKeys, onChange }: Props) {
  const meta = fieldMeta(field.type);
  const isPresentational = meta?.presentational ?? false;
  const needsOptions = meta?.needsOptions ?? false;

  const patch = useCallback(
    (changes: Partial<FormFieldDefinition>) => onChange({ ...field, ...changes }),
    [field, onChange],
  );

  const patchValidation = useCallback(
    (changes: Partial<FormFieldDefinition['validation']>) =>
      onChange({ ...field, validation: { ...field.validation, ...changes } }),
    [field, onChange],
  );

  const updateOption = useCallback(
    (index: number, changes: Partial<FieldOption>) => {
      const options = field.options.map((option, position) =>
        position === index ? { ...option, ...changes } : option,
      );
      patch({ options });
    },
    [field.options, patch],
  );

  return (
    <BlockStack gap="400">
      <TextField
        label="Label"
        value={field.label}
        onChange={(label) => patch({ label })}
        autoComplete="off"
        helpText="What the shopper sees above this field."
      />

      <TextField
        label="Field key"
        value={field.key}
        onChange={(key) => patch({ key })}
        autoComplete="off"
        disabled={field.system}
        helpText={
          field.system
            ? 'Built-in fields keep their key — your order pipeline and Google Sheets mapping reference it.'
            : 'Used as the column name in Google Sheets and on the order record. Letters, numbers and underscores.'
        }
      />

      <Select
        label="Type"
        options={[{ label: meta?.label ?? field.type, value: field.type }]}
        value={field.type}
        disabled
        onChange={() => undefined}
        helpText={
          field.system
            ? 'Built-in fields keep their type.'
            : 'Delete and re-add the field to change its type — changing it in place would invalidate any answers already collected.'
        }
      />

      {!isPresentational ? (
        <>
          <TextField
            label="Placeholder"
            value={field.placeholder ?? ''}
            onChange={(placeholder) => patch({ placeholder: placeholder || null })}
            autoComplete="off"
          />

          <TextField
            label="Help text"
            value={field.helpText ?? ''}
            onChange={(helpText) => patch({ helpText: helpText || null })}
            autoComplete="off"
            multiline={2}
          />
        </>
      ) : null}

      <Select
        label="Width"
        options={[
          { label: 'Full width', value: '12' },
          { label: 'Half', value: '6' },
          { label: 'One third', value: '4' },
          { label: 'Two thirds', value: '8' },
        ]}
        value={String(field.columnWidth)}
        onChange={(value) => patch({ columnWidth: Number(value) })}
        helpText="Fields always go full width on phones, whatever you choose here."
      />

      {!isPresentational ? (
        <>
          <Divider />

          <Text as="h3" variant="headingSm">
            Validation
          </Text>

          <Checkbox
            label="Required"
            checked={field.validation.required}
            onChange={(required) => patchValidation({ required })}
            disabled={field.key === 'phone'}
            helpText={
              field.key === 'phone'
                ? 'A COD order is confirmed by phone, so this field stays required.'
                : undefined
            }
          />

          <InlineStack gap="300" wrap={false}>
            <Box width="50%">
              <TextField
                label="Minimum length"
                type="number"
                value={field.validation.minLength?.toString() ?? ''}
                onChange={(value) =>
                  patchValidation({ minLength: value === '' ? null : Number(value) })
                }
                autoComplete="off"
              />
            </Box>
            <Box width="50%">
              <TextField
                label="Maximum length"
                type="number"
                value={field.validation.maxLength?.toString() ?? ''}
                onChange={(value) =>
                  patchValidation({ maxLength: value === '' ? null : Number(value) })
                }
                autoComplete="off"
              />
            </Box>
          </InlineStack>

          {field.type === 'NUMBER' || field.type === 'QUANTITY' ? (
            <InlineStack gap="300" wrap={false}>
              <Box width="50%">
                <TextField
                  label="Minimum value"
                  type="number"
                  value={field.validation.minValue?.toString() ?? ''}
                  onChange={(value) =>
                    patchValidation({ minValue: value === '' ? null : Number(value) })
                  }
                  autoComplete="off"
                />
              </Box>
              <Box width="50%">
                <TextField
                  label="Maximum value"
                  type="number"
                  value={field.validation.maxValue?.toString() ?? ''}
                  onChange={(value) =>
                    patchValidation({ maxValue: value === '' ? null : Number(value) })
                  }
                  autoComplete="off"
                />
              </Box>
            </InlineStack>
          ) : null}

          <TextField
            label="Pattern"
            value={field.validation.pattern ?? ''}
            onChange={(pattern) => patchValidation({ pattern: pattern || null })}
            autoComplete="off"
            monospaced
            helpText="A regular expression the value must match. Leave blank for none. Patterns that repeat inside a repeated group are rejected — they can hang a shopper's browser."
          />

          <TextField
            label="Error message"
            value={field.validation.message ?? ''}
            onChange={(message) => patchValidation({ message: message || null })}
            autoComplete="off"
            helpText="Shown instead of the default message when this field fails validation."
          />
        </>
      ) : null}

      {needsOptions ? (
        <>
          <Divider />

          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Options
            </Text>
            <Button
              icon={PlusIcon}
              variant="tertiary"
              onClick={() =>
                patch({
                  options: [
                    ...field.options,
                    {
                      label: `Option ${field.options.length + 1}`,
                      value: `option_${field.options.length + 1}`,
                    },
                  ],
                })
              }
            >
              Add option
            </Button>
          </InlineStack>

          <BlockStack gap="200">
            {field.options.map((option, index) => (
              <InlineStack key={index} gap="200" blockAlign="end" wrap={false}>
                <Box width="45%">
                  <TextField
                    label="Label"
                    labelHidden={index > 0}
                    value={option.label}
                    onChange={(label) => updateOption(index, { label })}
                    autoComplete="off"
                  />
                </Box>
                <Box width="45%">
                  <TextField
                    label="Value"
                    labelHidden={index > 0}
                    value={option.value}
                    onChange={(value) => updateOption(index, { value })}
                    autoComplete="off"
                    helpText={index === 0 ? 'Stored on the order.' : undefined}
                  />
                </Box>
                <Button
                  icon={DeleteIcon}
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel={`Remove ${option.label}`}
                  onClick={() =>
                    patch({ options: field.options.filter((_, position) => position !== index) })
                  }
                />
              </InlineStack>
            ))}
          </BlockStack>
        </>
      ) : null}

      <Divider />

      <Text as="h3" variant="headingSm">
        Show this field only when…
      </Text>

      {field.conditional ? (
        <BlockStack gap="300">
          {field.conditional.conditions.map((condition, index) => {
            const isUnary = UNARY_OPERATORS.includes(condition.operator);

            return (
              <InlineStack key={index} gap="200" blockAlign="end" wrap={false}>
                <Box width="35%">
                  <Select
                    label="Field"
                    labelHidden={index > 0}
                    options={siblingKeys.map((sibling) => ({
                      label: sibling.label,
                      value: sibling.key,
                    }))}
                    value={condition.field}
                    onChange={(value) => {
                      const conditions = field.conditional!.conditions.map((entry, position) =>
                        position === index ? { ...entry, field: value } : entry,
                      );
                      patch({ conditional: { ...field.conditional!, conditions } });
                    }}
                  />
                </Box>

                <Box width="30%">
                  <Select
                    label="Is"
                    labelHidden={index > 0}
                    options={Object.values(ConditionOperator).map((operator) => ({
                      label: OPERATOR_LABELS[operator] ?? operator,
                      value: operator,
                    }))}
                    value={condition.operator}
                    onChange={(value) => {
                      const conditions = field.conditional!.conditions.map((entry, position) =>
                        position === index
                          ? { ...entry, operator: value as typeof entry.operator }
                          : entry,
                      );
                      patch({ conditional: { ...field.conditional!, conditions } });
                    }}
                  />
                </Box>

                <Box width="30%">
                  <TextField
                    label="Value"
                    labelHidden={index > 0}
                    value={condition.value === undefined ? '' : String(condition.value)}
                    // `is empty` and `is not empty` take no right-hand value;
                    // leaving the input enabled invites a value that is then
                    // silently ignored.
                    disabled={isUnary}
                    onChange={(value) => {
                      const conditions = field.conditional!.conditions.map((entry, position) =>
                        position === index ? { ...entry, value } : entry,
                      );
                      patch({ conditional: { ...field.conditional!, conditions } });
                    }}
                    autoComplete="off"
                  />
                </Box>

                <Button
                  icon={DeleteIcon}
                  variant="tertiary"
                  tone="critical"
                  accessibilityLabel="Remove condition"
                  onClick={() => {
                    const conditions = field.conditional!.conditions.filter(
                      (_, position) => position !== index,
                    );
                    patch({
                      conditional:
                        conditions.length > 0 ? { ...field.conditional!, conditions } : null,
                    });
                  }}
                />
              </InlineStack>
            );
          })}

          <InlineStack gap="200">
            <Button
              variant="tertiary"
              onClick={() =>
                patch({
                  conditional: {
                    ...field.conditional!,
                    conditions: [
                      ...field.conditional!.conditions,
                      { field: siblingKeys[0]?.key ?? '', operator: ConditionOperator.EQUALS, value: '' },
                    ],
                  },
                })
              }
            >
              Add condition
            </Button>

            <Select
              label="Match"
              labelInline
              options={[
                { label: 'all conditions', value: 'all' },
                { label: 'any condition', value: 'any' },
              ]}
              value={field.conditional.logic}
              onChange={(value) =>
                patch({ conditional: { ...field.conditional!, logic: value as 'all' | 'any' } })
              }
            />
          </InlineStack>
        </BlockStack>
      ) : (
        <Button
          variant="tertiary"
          disabled={siblingKeys.length === 0}
          onClick={() =>
            patch({
              conditional: {
                logic: 'all',
                conditions: [
                  { field: siblingKeys[0]?.key ?? '', operator: ConditionOperator.EQUALS, value: '' },
                ],
              },
            })
          }
        >
          Add a condition
        </Button>
      )}
    </BlockStack>
  );
}

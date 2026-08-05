import { useCallback } from 'react';
import { BlockStack, Button, Icon, InlineStack, Select, Text, TextField } from '@shopify/polaris';
import { DeleteIcon, PlusIcon } from '@shopify/polaris-icons';
import {
  MAX_SHEET_COLUMNS,
  SHEET_FIELD_SOURCES,
  columnLetter,
  sheetFieldSource,
  type SheetFieldGroup,
} from '@codflow/shared';

/**
 * The spreadsheet-style column mapper.
 *
 * Laid out as the sheet itself is — lettered column headers with a field
 * chooser beneath each — because the merchant is deciding what their
 * spreadsheet looks like, and a vertical list of "field → column" pairs makes
 * them do that translation in their head.
 *
 * The letters are display only. Position in this row *is* the mapping; the
 * server assigns letters from array index on save, so what the merchant sees
 * here and what lands in the sheet cannot disagree.
 */

export interface MappedColumn {
  source: string;
  header: string;
}

interface Props {
  columns: MappedColumn[];
  /** Custom form fields, gathered from the merchant's own forms. */
  customFields: readonly { key: string; label: string }[];
  onChange: (columns: MappedColumn[]) => void;
}

export function ColumnMapper({ columns, customFields, onChange }: Props) {
  /**
   * Options for one column's dropdown.
   *
   * A field already used elsewhere is omitted — one field cannot occupy two
   * columns, and the server rejects it — but the column's *own* current value
   * is always kept, or the Select would render with no matching option and
   * appear blank.
   */
  const optionsFor = useCallback(
    (index: number) => {
      const takenElsewhere = new Set(
        columns.filter((_, position) => position !== index).map((column) => column.source),
      );

      const groups = new Map<SheetFieldGroup | 'Custom fields', Array<{ label: string; value: string }>>();

      for (const source of SHEET_FIELD_SOURCES) {
        if (takenElsewhere.has(source.key)) continue;

        const bucket = groups.get(source.group) ?? [];
        bucket.push({ label: source.label, value: source.key });
        groups.set(source.group, bucket);
      }

      for (const field of customFields) {
        const value = `customFields.${field.key}`;
        if (takenElsewhere.has(value)) continue;

        const bucket = groups.get('Custom fields') ?? [];
        bucket.push({ label: field.label, value });
        groups.set('Custom fields', bucket);
      }

      return [...groups.entries()].map(([title, options]) => ({ title, options }));
    },
    [columns, customFields],
  );

  const update = useCallback(
    (index: number, changes: Partial<MappedColumn>) => {
      onChange(
        columns.map((column, position) =>
          position === index ? { ...column, ...changes } : column,
        ),
      );
    },
    [columns, onChange],
  );

  /** Changing the field resets the header to that field's default. */
  const changeSource = useCallback(
    (index: number, source: string) => {
      const meta = sheetFieldSource(source);
      const custom = source.startsWith('customFields.')
        ? customFields.find((field) => `customFields.${field.key}` === source)
        : undefined;

      const currentHeader = columns[index]?.header;
      const previousDefault = sheetFieldSource(columns[index]?.source ?? '')?.defaultHeader;

      // Only overwrite a header the merchant has not customised — otherwise a
      // stray dropdown change would silently discard their wording.
      const keepHeader = currentHeader && currentHeader !== previousDefault;

      update(index, {
        source,
        ...(keepHeader ? {} : { header: meta?.defaultHeader ?? custom?.label ?? source }),
      });
    },
    [columns, customFields, update],
  );

  const addColumn = useCallback(() => {
    const taken = new Set(columns.map((column) => column.source));
    const next = SHEET_FIELD_SOURCES.find((source) => !taken.has(source.key));

    if (!next) return;

    onChange([...columns, { source: next.key, header: next.defaultHeader }]);
  }, [columns, onChange]);

  const removeColumn = useCallback(
    (index: number) => onChange(columns.filter((_, position) => position !== index)),
    [columns, onChange],
  );

  return (
    <BlockStack gap="300">
      {/*
        Horizontally scrollable. A mapping of twelve columns will not fit an
        embedded app's width on any realistic screen, and wrapping would break
        the spreadsheet metaphor that makes this readable at a glance.
      */}
      <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
        <div style={{ display: 'flex', gap: 12, minWidth: 'min-content' }}>
          {columns.map((column, index) => (
            <div key={index} style={{ minWidth: 200, flex: '0 0 auto' }}>
              <div
                style={{
                  textAlign: 'center',
                  padding: '4px 0',
                  marginBottom: 6,
                  borderRadius: 6,
                  background: 'var(--p-color-bg-surface-info)',
                  border: '1px solid var(--p-color-border)',
                }}
              >
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {columnLetter(index)}
                </Text>
              </div>

              <BlockStack gap="200">
                <Select
                  label={`Column ${columnLetter(index)} field`}
                  labelHidden
                  options={optionsFor(index)}
                  value={column.source}
                  onChange={(value) => changeSource(index, value)}
                />

                <TextField
                  label={`Column ${columnLetter(index)} header`}
                  labelHidden
                  value={column.header}
                  onChange={(header) => update(index, { header })}
                  autoComplete="off"
                  placeholder="Header text"
                />

                <Button
                  icon={DeleteIcon}
                  variant="tertiary"
                  tone="critical"
                  fullWidth
                  disabled={columns.length <= 1}
                  onClick={() => removeColumn(index)}
                  accessibilityLabel={`Remove column ${columnLetter(index)}`}
                />
              </BlockStack>
            </div>
          ))}
        </div>
      </div>

      <InlineStack align="space-between" blockAlign="center">
        <Button
          icon={PlusIcon}
          onClick={addColumn}
          disabled={columns.length >= MAX_SHEET_COLUMNS}
        >
          Add column
        </Button>

        <Text as="span" variant="bodySm" tone="subdued">
          {columns.length} of {MAX_SHEET_COLUMNS} columns
        </Text>
      </InlineStack>
    </BlockStack>
  );
}

/** Small helper so the page can render an inline icon without importing Polaris icons. */
export function DragHint() {
  return (
    <InlineStack gap="100" blockAlign="center">
      <Icon source={PlusIcon} tone="subdued" />
      <Text as="span" variant="bodySm" tone="subdued">
        Columns are written left to right, in this order.
      </Text>
    </InlineStack>
  );
}

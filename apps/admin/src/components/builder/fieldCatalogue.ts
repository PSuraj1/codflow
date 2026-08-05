import type { FormFieldDefinition } from '@codflow/shared';

/**
 * The palette of field types a merchant can add.
 *
 * Ordered by how often they are actually used on a COD form rather than
 * alphabetically or by the enum's declaration order — a merchant adding a field
 * is nearly always adding a text input or a dropdown, and making them scroll
 * past `VARIANT_PICKER` to reach it is a small tax paid on every edit.
 */

export interface FieldTypeMeta {
  readonly type: FormFieldDefinition['type'];
  readonly label: string;
  readonly description: string;
  /** Whether the type needs an options list before it can be saved. */
  readonly needsOptions: boolean;
  /** Presentation-only: carries no value and cannot be required. */
  readonly presentational: boolean;
}

export const FIELD_CATALOGUE: readonly FieldTypeMeta[] = [
  {
    type: 'TEXT',
    label: 'Text',
    description: 'A single line of text.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'TEXTAREA',
    label: 'Long text',
    description: 'Multiple lines — delivery notes, instructions.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'PHONE',
    label: 'Phone',
    description: 'Validated per country when the order is placed.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'EMAIL',
    label: 'Email',
    description: 'Used for the order confirmation.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'NUMBER',
    label: 'Number',
    description: 'Numeric input with optional minimum and maximum.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'SELECT',
    label: 'Dropdown',
    description: 'One choice from a list.',
    needsOptions: true,
    presentational: false,
  },
  {
    type: 'RADIO',
    label: 'Radio buttons',
    description: 'One choice, all options visible.',
    needsOptions: true,
    presentational: false,
  },
  {
    type: 'MULTISELECT',
    label: 'Multi-select',
    description: 'Several choices from a list.',
    needsOptions: true,
    presentational: false,
  },
  {
    type: 'CHECKBOX',
    label: 'Checkbox',
    description: 'A single yes or no.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'CONSENT',
    label: 'Consent',
    description: 'Must be ticked to submit — terms, marketing opt-in.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'COUNTRY',
    label: 'Country',
    description: 'Country selector. Also sets how the phone number is validated.',
    needsOptions: true,
    presentational: false,
  },
  {
    type: 'STATE',
    label: 'State / province',
    description: 'Region selector.',
    needsOptions: true,
    presentational: false,
  },
  {
    type: 'CITY',
    label: 'City',
    description: 'City name.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'POSTAL_CODE',
    label: 'PIN / postal code',
    description: 'Postal code, validated by your pattern.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'DATE',
    label: 'Date',
    description: 'Date picker — preferred delivery date, for example.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'QUANTITY',
    label: 'Quantity',
    description: 'How many units. Updates the order total live.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'HIDDEN',
    label: 'Hidden',
    description: 'Not shown to the shopper. Carries a fixed value onto the order.',
    needsOptions: false,
    presentational: false,
  },
  {
    type: 'HEADING',
    label: 'Heading',
    description: 'Section title. Not a field.',
    needsOptions: false,
    presentational: true,
  },
  {
    type: 'PARAGRAPH',
    label: 'Paragraph',
    description: 'Explanatory text. Not a field.',
    needsOptions: false,
    presentational: true,
  },
  {
    type: 'DIVIDER',
    label: 'Divider',
    description: 'A horizontal rule. Not a field.',
    needsOptions: false,
    presentational: true,
  },
];

const BY_TYPE = new Map(FIELD_CATALOGUE.map((entry) => [entry.type, entry]));

export function fieldMeta(type: FormFieldDefinition['type']): FieldTypeMeta | undefined {
  return BY_TYPE.get(type);
}

/**
 * Proposes a unique key for a newly added field.
 *
 * Keys are permanent in practice — they are what the order pipeline, the Google
 * Sheets column mapping and any saved conditional rule all reference — so the
 * generator produces something readable rather than a random id a merchant
 * would later have to decipher in a spreadsheet column header.
 */
export function suggestKey(label: string, existing: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f$1') || 'field';

  const taken = new Set(existing);
  if (!taken.has(base)) return base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${base}_${Date.now()}`;
}

/** A blank field of the given type, ready to drop into the builder. */
export function blankField(
  type: FormFieldDefinition['type'],
  existingKeys: readonly string[],
): FormFieldDefinition {
  const meta = fieldMeta(type);
  const label = meta?.label ?? 'Field';

  return {
    // Temporary client-side id. The absence of a real one is how the API knows
    // this is a create rather than an update, so it is stripped before saving.
    id: `new-${Math.random().toString(36).slice(2, 10)}`,
    key: suggestKey(label, existingKeys),
    type,
    label,
    placeholder: null,
    helpText: null,
    position: 0,
    enabled: true,
    system: false,
    hidden: type === 'HIDDEN',
    defaultValue: null,
    validation: { required: false },
    options: meta?.needsOptions ? [{ label: 'Option 1', value: 'option_1' }] : [],
    conditional: null,
    columnWidth: 12,
    cssClass: null,
    translations: {},
  };
}

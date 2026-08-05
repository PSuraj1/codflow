import type { FormConfig, FormField, Prisma } from '@prisma/client';
import type {
  FieldConditionalRule,
  FieldOption,
  FormDefinition,
  FormFieldDefinition,
} from '@codflow/shared';

/**
 * Translation between the database rows and the shared form contract.
 *
 * The two shapes differ deliberately. Prisma stores validation as flat columns
 * (`minLength`, `maxLength`, `regexPattern`) because that is what indexes and
 * migrates well; the contract groups them under `validation` because that is
 * what the builder and the validator want to pass around as a unit. Keeping the
 * conversion in one file means neither side has to know about the other's
 * shape.
 *
 * JSON columns are the risky part. Prisma types them as `JsonValue`, which is
 * `any`-adjacent, so every read below is defensive: a column written by an
 * older build, or hand-edited, must not crash the storefront renderer.
 */

/** Prisma's Decimal for min/max value columns. Null-safe. */
function toNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Reads the `options` JSON column.
 *
 * Anything that is not a well-formed option is dropped rather than passed
 * through — a half-written option renders as an empty `<option>` that a shopper
 * can select, producing an order with a blank value.
 */
function parseOptions(value: Prisma.JsonValue): FieldOption[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): FieldOption[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];

    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label : null;
    const optionValue = typeof record.value === 'string' ? record.value : null;

    if (!label || !optionValue) return [];

    const translations =
      typeof record.translations === 'object' &&
      record.translations !== null &&
      !Array.isArray(record.translations)
        ? (record.translations as Record<string, string>)
        : undefined;

    return [{ label, value: optionValue, ...(translations ? { translations } : {}) }];
  });
}

/**
 * Reads the `conditionalOn` JSON column.
 *
 * Accepts both shapes the column has held: the current
 * `{ logic, conditions: [...] }`, and the single-condition
 * `{ field, operator, value }` the schema comment documents. Normalising here
 * rather than migrating the data keeps old rows working, and the write path
 * only ever emits the current shape.
 */
function parseConditional(value: Prisma.JsonValue): FieldConditionalRule | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;

  if (Array.isArray(record.conditions)) {
    const conditions = record.conditions.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
      const condition = entry as Record<string, unknown>;
      if (typeof condition.field !== 'string' || typeof condition.operator !== 'string') return [];

      return [
        {
          field: condition.field,
          operator: condition.operator as FieldConditionalRule['conditions'][number]['operator'],
          value: condition.value as never,
        },
      ];
    });

    if (conditions.length === 0) return null;

    return { logic: record.logic === 'any' ? 'any' : 'all', conditions };
  }

  // Legacy single-condition form.
  if (typeof record.field === 'string' && typeof record.operator === 'string') {
    return {
      logic: 'all',
      conditions: [
        {
          field: record.field,
          operator: record.operator as FieldConditionalRule['conditions'][number]['operator'],
          value: record.value as never,
        },
      ],
    };
  }

  return null;
}

function parseTranslations(value: Prisma.JsonValue): FormFieldDefinition['translations'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as FormFieldDefinition['translations'];
}

export function toFieldDefinition(field: FormField): FormFieldDefinition {
  return {
    id: field.id,
    key: field.key,
    type: field.type,
    label: field.label,
    placeholder: field.placeholder,
    helpText: field.helpText,
    position: field.position,
    enabled: field.isEnabled,
    system: field.isSystem,
    hidden: field.isHidden,
    defaultValue: field.defaultValue,
    validation: {
      required: field.isRequired,
      minLength: field.minLength,
      maxLength: field.maxLength,
      minValue: toNumber(field.minValue),
      maxValue: toNumber(field.maxValue),
      pattern: field.regexPattern,
      message: field.validationMessage,
    },
    options: parseOptions(field.options),
    conditional: parseConditional(field.conditionalOn),
    columnWidth: field.columnWidth,
    cssClass: field.cssClass,
    translations: parseTranslations(field.translations),
  };
}

export function toFormDefinition(
  form: FormConfig & { fields: FormField[] },
): FormDefinition {
  return {
    id: form.id,
    name: form.name,
    active: form.isActive,
    isDefault: form.isDefault,
    headingText: form.headingText,
    subheadingText: form.subheadingText,
    submitButtonText: form.submitButtonText,
    successMessage: form.successMessage,
    translations: parseTranslations(form.translations) as FormDefinition['translations'],
    layout: form.layout === 'two_column' ? 'two_column' : 'single_column',
    showOrderSummary: form.showOrderSummary,
    showProductImage: form.showProductImage,
    showQuantitySelector: form.showQuantitySelector,
    showVariantSelector: form.showVariantSelector,
    showCouponField: form.showCouponField,
    showTermsCheckbox: form.showTermsCheckbox,
    termsUrl: form.termsUrl,
    requireOtp: form.requireOtp,
    trackAbandonment: form.trackAbandonment,
    abandonmentDelaySeconds: form.abandonmentDelaySeconds,
    botProtection: form.botProtection,
    minFillSeconds: form.minFillSeconds,
    // Sorted here rather than relying on the caller's query: the storefront
    // renders in array order, and an unordered list is a scrambled form.
    fields: form.fields
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(toFieldDefinition),
  };
}

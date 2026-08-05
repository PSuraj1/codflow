import {
  ConditionOperator,
  UNARY_OPERATORS,
  type FieldCondition,
  type FieldConditionalRule,
  type FormFieldDefinition,
} from '../contracts/forms.js';

/**
 * Conditional visibility.
 *
 * A merchant can say "show the landmark field only when country is India". The
 * storefront uses this to decide what to draw; the server uses the *same* code
 * to decide what to validate. That symmetry is the point: if the server
 * evaluated conditions differently, it would demand a field the shopper was
 * never shown, and the form would be impossible to submit.
 */

/** A submitted form value, before coercion. */
export type FieldValue = string | number | boolean | string[] | null | undefined;

export type FormValues = Record<string, FieldValue>;

/**
 * Emptiness, defined once.
 *
 * `false` is deliberately *not* empty: an unchecked consent box has a real
 * value, and treating it as empty would make `is_empty` true for a box the
 * shopper deliberately left unticked — which reads as "they did not answer"
 * rather than "they answered no". `0` is likewise a real quantity.
 */
export function isEmpty(value: FieldValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Comparable string form, for the text operators. */
function asString(value: FieldValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

/**
 * Numeric form, or NaN.
 *
 * `Number('')` is 0, which would make an empty field compare as less than any
 * threshold — so an empty value is forced to NaN and every numeric comparison
 * against it returns false.
 */
function asNumber(value: FieldValue): number {
  if (isEmpty(value)) return Number.NaN;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return Number.NaN;
  return Number(value);
}

function asArray(value: FieldCondition['value']): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

/** Evaluates one condition against the current values. */
export function evaluateCondition(condition: FieldCondition, values: FormValues): boolean {
  const actual = values[condition.field];

  switch (condition.operator) {
    case ConditionOperator.IS_EMPTY:
      return isEmpty(actual);

    case ConditionOperator.IS_NOT_EMPTY:
      return !isEmpty(actual);

    case ConditionOperator.EQUALS:
      // Compared as strings so a numeric field whose value arrives as "3" from
      // a form post still matches a condition authored as the number 3.
      return asString(actual) === asString(condition.value as FieldValue);

    case ConditionOperator.NOT_EQUALS:
      return asString(actual) !== asString(condition.value as FieldValue);

    case ConditionOperator.CONTAINS:
      return Array.isArray(actual)
        ? actual.map(String).includes(String(condition.value))
        : asString(actual).toLowerCase().includes(String(condition.value ?? '').toLowerCase());

    case ConditionOperator.NOT_CONTAINS:
      return Array.isArray(actual)
        ? !actual.map(String).includes(String(condition.value))
        : !asString(actual).toLowerCase().includes(String(condition.value ?? '').toLowerCase());

    case ConditionOperator.IN:
      return asArray(condition.value).includes(asString(actual));

    case ConditionOperator.NOT_IN:
      return !asArray(condition.value).includes(asString(actual));

    case ConditionOperator.GREATER_THAN: {
      const left = asNumber(actual);
      const right = asNumber(condition.value as FieldValue);
      return Number.isFinite(left) && Number.isFinite(right) && left > right;
    }

    case ConditionOperator.LESS_THAN: {
      const left = asNumber(actual);
      const right = asNumber(condition.value as FieldValue);
      return Number.isFinite(left) && Number.isFinite(right) && left < right;
    }

    case ConditionOperator.GREATER_OR_EQUAL: {
      const left = asNumber(actual);
      const right = asNumber(condition.value as FieldValue);
      return Number.isFinite(left) && Number.isFinite(right) && left >= right;
    }

    case ConditionOperator.LESS_OR_EQUAL: {
      const left = asNumber(actual);
      const right = asNumber(condition.value as FieldValue);
      return Number.isFinite(left) && Number.isFinite(right) && left <= right;
    }

    default:
      // An operator this build does not recognise — a form authored by a newer
      // version. Failing open keeps the field visible, which is recoverable;
      // failing closed would silently hide a required field and make the form
      // unsubmittable with no explanation.
      return true;
  }
}

/** Evaluates a whole rule. An empty condition list means "always visible". */
export function evaluateRule(rule: FieldConditionalRule, values: FormValues): boolean {
  if (rule.conditions.length === 0) return true;

  return rule.logic === 'any'
    ? rule.conditions.some((condition) => evaluateCondition(condition, values))
    : rule.conditions.every((condition) => evaluateCondition(condition, values));
}

/**
 * Resolves visibility for every field at once.
 *
 * Conditions may chain — B depends on A, C depends on B — so this iterates to a
 * fixed point rather than evaluating in a single pass. A field whose controller
 * is itself hidden is treated as having no value, which cascades hiding down the
 * chain the way a merchant expects.
 *
 * The iteration is bounded by the field count: each pass can only ever hide
 * more fields, never fewer, so it converges in at most one pass per field. The
 * bound also contains a circular rule (A depends on B, B depends on A) instead
 * of spinning forever — a builder can author that, and it must not hang a
 * shopper's browser.
 */
export function resolveVisibility(
  fields: readonly FormFieldDefinition[],
  values: FormValues,
): Record<string, boolean> {
  const visible: Record<string, boolean> = {};

  for (const field of fields) {
    visible[field.key] = field.enabled;
  }

  for (let pass = 0; pass <= fields.length; pass += 1) {
    let changed = false;

    // Values as seen through current visibility: a hidden field contributes
    // nothing, so its dependents evaluate against an absent value.
    const effective: FormValues = {};
    for (const field of fields) {
      effective[field.key] = visible[field.key] ? values[field.key] : undefined;
    }

    for (const field of fields) {
      if (!field.enabled || !field.conditional) continue;

      const shouldShow = evaluateRule(field.conditional, effective);

      if (visible[field.key] !== shouldShow) {
        visible[field.key] = shouldShow;
        changed = true;
      }
    }

    if (!changed) break;
  }

  return visible;
}

/** True when an operator needs no right-hand value. */
export function isUnaryOperator(operator: ConditionOperator): boolean {
  return UNARY_OPERATORS.includes(operator);
}

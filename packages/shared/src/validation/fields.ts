import {
  MULTI_VALUE_TYPES,
  NUMERIC_TYPES,
  OPTION_TYPES,
  PRESENTATIONAL_TYPES,
  type FormFieldDefinition,
} from '../contracts/forms.js';
import { isEmpty, type FieldValue, type FormValues } from './conditions.js';

/**
 * Field-level validation.
 *
 * Runs unchanged in the shopper's browser and in the API. The browser's copy
 * exists to give immediate feedback; the API's copy is the one that decides
 * whether an order is created. Neither trusts the other, and because they are
 * the same function they cannot disagree about what a merchant's rules mean.
 */

export interface FieldError {
  readonly key: string;
  readonly message: string;
  /** Machine-readable reason, so a UI can style or translate independently. */
  readonly code: FieldErrorCode;
}

export const FieldErrorCode = {
  REQUIRED: 'required',
  TOO_SHORT: 'too_short',
  TOO_LONG: 'too_long',
  TOO_SMALL: 'too_small',
  TOO_LARGE: 'too_large',
  NOT_A_NUMBER: 'not_a_number',
  PATTERN: 'pattern',
  INVALID_EMAIL: 'invalid_email',
  INVALID_OPTION: 'invalid_option',
  CONSENT_REQUIRED: 'consent_required',
} as const;

export type FieldErrorCode = (typeof FieldErrorCode)[keyof typeof FieldErrorCode];

/**
 * Email shape check.
 *
 * Deliberately permissive. RFC 5322 admits addresses that no mail provider
 * accepts, and every attempt to encode it as one regular expression rejects
 * valid addresses — which on a COD form means refusing a real customer. This
 * catches typos and obvious junk; deliverability is not something a regex can
 * establish, and the disposable-address check in the fraud engine handles the
 * cases that actually matter.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Upper bound on any merchant-authored pattern.
 *
 * A regex is run once per keystroke in the browser and once per submission on
 * the server, both against attacker-influenceable input. Catastrophic
 * backtracking in a pattern a merchant pasted from the internet would hang
 * either one, so patterns are length-capped when they are saved and compiled
 * defensively here.
 */
const MAX_PATTERN_LENGTH = 500;

/** Cache of compiled patterns. Compiling a regex per keystroke is wasteful. */
const patternCache = new Map<string, RegExp | null>();

function compilePattern(source: string): RegExp | null {
  if (source.length > MAX_PATTERN_LENGTH) return null;

  const cached = patternCache.get(source);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(source);
  } catch {
    // An invalid pattern must not block a shopper. It is rejected at save time
    // in the admin; anything that reaches here predates that check.
    compiled = null;
  }

  patternCache.set(source, compiled);
  return compiled;
}

/** Normalizes a raw submitted value to the shape its field type implies. */
export function coerceValue(field: FormFieldDefinition, raw: FieldValue): FieldValue {
  if (MULTI_VALUE_TYPES.includes(field.type)) {
    if (Array.isArray(raw)) return raw.map(String);
    if (isEmpty(raw)) return [];
    return [String(raw)];
  }

  if (field.type === 'CHECKBOX' || field.type === 'CONSENT') {
    // HTML checkboxes post "on", "true" or "1" depending on the markup, and
    // nothing at all when unchecked.
    if (typeof raw === 'boolean') return raw;
    if (isEmpty(raw)) return false;
    const text = String(raw).toLowerCase();
    return text === 'true' || text === 'on' || text === '1' || text === 'yes';
  }

  if (NUMERIC_TYPES.includes(field.type)) {
    if (isEmpty(raw)) return null;
    const parsed = Number(raw);
    // NaN is preserved rather than nulled: "abc" in a number field is a
    // validation error the shopper should see, not a silently empty field.
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }

  if (isEmpty(raw)) return null;
  return typeof raw === 'string' ? raw.trim() : raw;
}

function message(field: FormFieldDefinition, fallback: string): string {
  return field.validation.message ?? fallback;
}

/**
 * Validates one field's value.
 *
 * Returns at most one error per field: a shopper fixing a phone number does not
 * benefit from being told it is simultaneously too short and badly formatted,
 * and showing the first failure keeps the form readable.
 */
export function validateField(
  field: FormFieldDefinition,
  raw: FieldValue,
): FieldError | null {
  if (PRESENTATIONAL_TYPES.includes(field.type)) return null;
  if (!field.enabled) return null;

  const value = coerceValue(field, raw);
  const rules = field.validation;

  // ---- Presence
  if (field.type === 'CONSENT') {
    // Consent is only meaningful when affirmative. An unticked box is a valid
    // boolean but not valid consent, so it gets its own code and message.
    if (rules.required && value !== true) {
      return {
        key: field.key,
        code: FieldErrorCode.CONSENT_REQUIRED,
        message: message(field, `Please accept ${field.label.toLowerCase()} to continue.`),
      };
    }
    return null;
  }

  if (isEmpty(value) || (typeof value === 'number' && Number.isNaN(value))) {
    if (rules.required) {
      return {
        key: field.key,
        code: Number.isNaN(value as number) ? FieldErrorCode.NOT_A_NUMBER : FieldErrorCode.REQUIRED,
        message: message(
          field,
          Number.isNaN(value as number)
            ? `${field.label} must be a number.`
            : `${field.label} is required.`,
        ),
      };
    }

    // Empty and optional. Every remaining rule describes the *content* of a
    // value, so there is nothing left to check.
    return Number.isNaN(value as number)
      ? {
          key: field.key,
          code: FieldErrorCode.NOT_A_NUMBER,
          message: message(field, `${field.label} must be a number.`),
        }
      : null;
  }

  // ---- Length, for anything textual
  if (typeof value === 'string') {
    if (rules.minLength != null && value.length < rules.minLength) {
      return {
        key: field.key,
        code: FieldErrorCode.TOO_SHORT,
        message: message(field, `${field.label} must be at least ${rules.minLength} characters.`),
      };
    }

    if (rules.maxLength != null && value.length > rules.maxLength) {
      return {
        key: field.key,
        code: FieldErrorCode.TOO_LONG,
        message: message(field, `${field.label} must be at most ${rules.maxLength} characters.`),
      };
    }
  }

  // ---- Range, for anything numeric
  if (typeof value === 'number') {
    if (rules.minValue != null && value < rules.minValue) {
      return {
        key: field.key,
        code: FieldErrorCode.TOO_SMALL,
        message: message(field, `${field.label} must be at least ${rules.minValue}.`),
      };
    }

    if (rules.maxValue != null && value > rules.maxValue) {
      return {
        key: field.key,
        code: FieldErrorCode.TOO_LARGE,
        message: message(field, `${field.label} must be at most ${rules.maxValue}.`),
      };
    }
  }

  // ---- Type-specific shape
  if (field.type === 'EMAIL' && typeof value === 'string' && !EMAIL_PATTERN.test(value)) {
    return {
      key: field.key,
      code: FieldErrorCode.INVALID_EMAIL,
      message: message(field, 'Enter a valid email address.'),
    };
  }

  // ---- Option membership
  if (OPTION_TYPES.includes(field.type) && field.options.length > 0) {
    const allowed = new Set(field.options.map((option) => option.value));
    const selected = Array.isArray(value) ? value : [String(value)];

    if (selected.some((entry) => !allowed.has(entry))) {
      return {
        key: field.key,
        code: FieldErrorCode.INVALID_OPTION,
        message: message(field, `Select a valid option for ${field.label.toLowerCase()}.`),
      };
    }
  }

  // ---- Merchant pattern, last: it is the most expensive check and the most
  // likely to be misconfigured, so cheaper rules report first.
  if (rules.pattern && typeof value === 'string') {
    const compiled = compilePattern(rules.pattern);

    if (compiled && !compiled.test(value)) {
      return {
        key: field.key,
        code: FieldErrorCode.PATTERN,
        message: message(field, `${field.label} is not in the expected format.`),
      };
    }
  }

  return null;
}

/** Applies `coerceValue` across a whole submission. */
export function coerceValues(
  fields: readonly FormFieldDefinition[],
  values: FormValues,
): FormValues {
  const result: FormValues = {};

  for (const field of fields) {
    result[field.key] = coerceValue(field, values[field.key]);
  }

  return result;
}

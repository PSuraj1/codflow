import { PRESENTATIONAL_TYPES, type FormDefinition } from '../contracts/forms.js';
import { resolveVisibility, type FormValues } from './conditions.js';
import { validateField, type FieldError } from './fields.js';

/**
 * Whole-form validation.
 *
 * The single entry point both the storefront and the API call. Its most
 * important property is what it *skips*: a field hidden by a conditional rule
 * is not validated, even when it is marked required. Validating hidden fields
 * is the classic conditional-form bug — the shopper is told a field is required
 * while looking at a form that does not contain it, and there is no way for
 * them to proceed.
 */

export interface FormValidationResult {
  readonly valid: boolean;
  readonly errors: readonly FieldError[];
  /** Errors keyed by field, for binding straight onto inputs. */
  readonly errorsByKey: Readonly<Record<string, string>>;
  /** Which fields were visible, so the caller persists only what was asked for. */
  readonly visibility: Readonly<Record<string, boolean>>;
  /** Coerced values for visible fields only. */
  readonly values: FormValues;
}

export function validateForm(form: FormDefinition, values: FormValues): FormValidationResult {
  const visibility = resolveVisibility(form.fields, values);
  const errors: FieldError[] = [];
  const accepted: FormValues = {};

  for (const field of form.fields) {
    if (PRESENTATIONAL_TYPES.includes(field.type)) continue;
    if (!field.enabled) continue;

    if (!visibility[field.key]) {
      // Hidden by a condition. Deliberately not carried into `values` either —
      // persisting a value for a field the shopper never saw would put stale
      // data from an earlier answer onto the order.
      continue;
    }

    const error = validateField(field, values[field.key]);

    if (error) {
      errors.push(error);
    }

    accepted[field.key] = values[field.key] ?? null;
  }

  const errorsByKey: Record<string, string> = {};
  for (const error of errors) {
    // First error per field wins, matching `validateField`'s own behaviour of
    // reporting one reason at a time.
    if (!(error.key in errorsByKey)) errorsByKey[error.key] = error.message;
  }

  return {
    valid: errors.length === 0,
    errors,
    errorsByKey,
    visibility,
    values: accepted,
  };
}

/** Outcome of the bot heuristics. */
export interface BotCheckResult {
  readonly passed: boolean;
  readonly reason: 'honeypot' | 'too_fast' | null;
}

/**
 * Honeypot and fill-time checks.
 *
 * Two cheap signals that between them stop most automated COD spam without
 * putting a CAPTCHA in front of a paying customer:
 *
 *  - **Honeypot** — a field hidden with CSS that a human never sees and never
 *    fills. Anything in it came from a script that filled every input it found.
 *  - **Fill time** — a form submitted faster than a person could plausibly type
 *    an address. The threshold is a merchant setting because it trades false
 *    positives against coverage, and the right answer depends on how long their
 *    form is.
 *
 * Neither is a security control. Both are trivially defeated by an attacker who
 * looks at the page once — they raise the cost of *indiscriminate* abuse, which
 * is what COD forms actually attract. The fraud engine handles targeted abuse.
 */
export function checkBotSignals(
  form: FormDefinition,
  honeypotValue: unknown,
  renderedAtMs: number | null,
  now = Date.now(),
): BotCheckResult {
  if (!form.botProtection) return { passed: true, reason: null };

  if (typeof honeypotValue === 'string' && honeypotValue.trim().length > 0) {
    return { passed: false, reason: 'honeypot' };
  }

  if (renderedAtMs !== null && Number.isFinite(renderedAtMs)) {
    const elapsedSeconds = (now - renderedAtMs) / 1_000;

    // A negative elapsed time means the client clock is ahead of the server's.
    // That is common and harmless, so it is not treated as a bot signal — only
    // an implausibly *short* interval is.
    if (elapsedSeconds >= 0 && elapsedSeconds < form.minFillSeconds) {
      return { passed: false, reason: 'too_fast' };
    }
  }

  return { passed: true, reason: null };
}

/**
 * Applies a locale's overrides to a form.
 *
 * Returns a new definition with translated copy substituted, so the renderer
 * receives one already-localized object instead of resolving translations at
 * every field. Anything without a translation keeps its default text rather
 * than rendering blank.
 */
export function localizeForm(form: FormDefinition, locale: string): FormDefinition {
  const language = locale.split('-')[0]?.toLowerCase() ?? 'en';
  const formOverrides = form.translations[language] ?? {};

  return {
    ...form,
    headingText: formOverrides.headingText ?? form.headingText,
    subheadingText: formOverrides.subheadingText ?? form.subheadingText,
    submitButtonText: formOverrides.submitButtonText ?? form.submitButtonText,
    successMessage: formOverrides.successMessage ?? form.successMessage,
    fields: form.fields.map((field) => {
      const overrides = field.translations[language];
      if (!overrides) return field;

      return {
        ...field,
        label: overrides.label ?? field.label,
        placeholder: overrides.placeholder ?? field.placeholder,
        helpText: overrides.helpText ?? field.helpText,
        options: field.options.map((option) => ({
          ...option,
          label: option.translations?.[language] ?? option.label,
        })),
      };
    }),
  };
}

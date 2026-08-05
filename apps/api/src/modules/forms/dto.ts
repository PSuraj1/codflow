import { z } from 'zod';
import { ConditionOperator, UNARY_OPERATORS } from '@codflow/shared';

/**
 * Form builder request contracts.
 *
 * These carry more validation than a typical admin DTO because what they accept
 * becomes executable configuration: a regular expression here runs against
 * every shopper's keystrokes, and a conditional rule here decides whether a
 * required field is enforced. Accepting a malformed one produces a form that is
 * broken on the storefront but looks fine in the builder.
 */

const FIELD_TYPES = [
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'NUMBER',
  'SELECT',
  'MULTISELECT',
  'RADIO',
  'CHECKBOX',
  'COUNTRY',
  'STATE',
  'CITY',
  'POSTAL_CODE',
  'DATE',
  'HIDDEN',
  'HEADING',
  'PARAGRAPH',
  'DIVIDER',
  'QUANTITY',
  'VARIANT_PICKER',
  'CONSENT',
] as const;

/**
 * Upper bound on a merchant-authored pattern.
 *
 * Matches the ceiling the shared validator enforces at evaluation time. Capping
 * at save is what makes that ceiling meaningful — otherwise a long pattern is
 * accepted here and then silently ignored on the storefront, which is worse
 * than rejecting it.
 */
const MAX_PATTERN_LENGTH = 500;

/**
 * Rejects patterns whose structure invites catastrophic backtracking.
 *
 * A merchant pasting `^(a+)+$` from a forum would hang both the shopper's
 * browser and the API on a crafted input. This is a heuristic, not a decision
 * procedure — proving a regex safe is undecidable in general — so it targets
 * the shape that actually causes the problem: a quantifier applied to a group
 * that itself contains a quantifier.
 *
 * False positives are acceptable. A merchant blocked from saving an exotic
 * pattern can simplify it; a merchant who takes down their own storefront
 * cannot undo it.
 */
function looksCatastrophic(source: string): boolean {
  // (x+)+ (x*)* (x+)* (x{1,9})+ and the like.
  const nestedQuantifier = /\([^)]*[+*}][^)]*\)\s*[+*{]/;
  // Alternation where both branches can match the same text, then quantified:
  // (a|a)* is the textbook example.
  const quantifiedAlternation = /\([^)]*\|[^)]*\)\s*[+*]/;

  return nestedQuantifier.test(source) || quantifiedAlternation.test(source);
}

const regexPattern = z
  .string()
  .max(MAX_PATTERN_LENGTH, `Pattern must be at most ${MAX_PATTERN_LENGTH} characters`)
  .refine(
    (source) => {
      try {
        new RegExp(source);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Not a valid regular expression' },
  )
  .refine((source) => !looksCatastrophic(source), {
    message:
      'This pattern nests repetition inside a repeated group, which can hang a ' +
      'shopper’s browser on some inputs. Simplify it before saving.',
  });

/**
 * Field keys become JSON properties, Google Sheets column sources and Shopify
 * note attributes, so they are restricted to a shape that is safe everywhere:
 * no dots (which the Sheets mapping uses as a path separator), no leading
 * digits, no whitespace.
 */
const fieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]*$/,
    'Key must start with a letter and contain only letters, numbers and underscores',
  );

const fieldOption = z.object({
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(200),
  translations: z.record(z.string(), z.string().max(200)).optional(),
});

const fieldCondition = z
  .object({
    field: fieldKey,
    operator: z.enum(Object.values(ConditionOperator) as [string, ...string[]]),
    value: z
      .union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(100)])
      .optional(),
  })
  .refine(
    (condition) =>
      UNARY_OPERATORS.includes(condition.operator as never) || condition.value !== undefined,
    { message: 'This operator requires a value', path: ['value'] },
  );

const conditionalRule = z.object({
  logic: z.enum(['all', 'any']).default('all'),
  // Bounded: each condition is evaluated on every keystroke, and the visibility
  // resolver runs one pass per field.
  conditions: z.array(fieldCondition).min(1).max(10),
});

const fieldValidation = z
  .object({
    required: z.boolean().default(false),
    minLength: z.number().int().min(0).max(10_000).nullish(),
    maxLength: z.number().int().min(1).max(10_000).nullish(),
    minValue: z.number().min(-1_000_000_000).max(1_000_000_000).nullish(),
    maxValue: z.number().min(-1_000_000_000).max(1_000_000_000).nullish(),
    pattern: regexPattern.nullish(),
    message: z.string().max(300).nullish(),
  })
  .refine(
    (rules) =>
      rules.minLength == null || rules.maxLength == null || rules.minLength <= rules.maxLength,
    { message: 'Minimum length cannot exceed maximum length', path: ['minLength'] },
  )
  .refine(
    (rules) => rules.minValue == null || rules.maxValue == null || rules.minValue <= rules.maxValue,
    { message: 'Minimum value cannot exceed maximum value', path: ['minValue'] },
  );

export const FormFieldInputSchema = z.object({
  /** Absent when creating. Present when updating an existing field. */
  id: z.string().cuid().optional(),
  key: fieldKey,
  type: z.enum(FIELD_TYPES),
  label: z.string().min(1).max(200),
  placeholder: z.string().max(200).nullish(),
  helpText: z.string().max(500).nullish(),
  enabled: z.boolean().default(true),
  hidden: z.boolean().default(false),
  defaultValue: z.string().max(500).nullish(),
  validation: fieldValidation.default({ required: false }),
  options: z.array(fieldOption).max(200).default([]),
  conditional: conditionalRule.nullish(),
  columnWidth: z.number().int().min(1).max(12).default(12),
  cssClass: z.string().max(200).nullish(),
  translations: z
    .record(
      z.string().max(10),
      z.object({
        label: z.string().max(200).optional(),
        placeholder: z.string().max(200).optional(),
        helpText: z.string().max(500).optional(),
      }),
    )
    .default({}),
});

export type FormFieldInput = z.infer<typeof FormFieldInputSchema>;

export const CreateFormSchema = z.object({
  name: z.string().min(1).max(120),
  headingText: z.string().max(200).default('Cash On Delivery'),
  subheadingText: z.string().max(500).nullish(),
  submitButtonText: z.string().max(120).default('Place Order'),
  successMessage: z.string().max(500).default('Thank you! Your order has been placed.'),
});

export type CreateFormInput = z.infer<typeof CreateFormSchema>;

export const UpdateFormSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  headingText: z.string().max(200).optional(),
  subheadingText: z.string().max(500).nullish(),
  submitButtonText: z.string().max(120).optional(),
  successMessage: z.string().max(500).optional(),
  translations: z.record(z.string().max(10), z.record(z.string(), z.string().max(500))).optional(),

  layout: z.enum(['single_column', 'two_column']).optional(),
  showOrderSummary: z.boolean().optional(),
  showProductImage: z.boolean().optional(),
  showQuantitySelector: z.boolean().optional(),
  showVariantSelector: z.boolean().optional(),
  showCouponField: z.boolean().optional(),
  showTermsCheckbox: z.boolean().optional(),
  termsUrl: z.url().max(500).nullish(),

  requireOtp: z.boolean().optional(),
  trackAbandonment: z.boolean().optional(),
  abandonmentDelaySeconds: z.number().int().min(0).max(3_600).optional(),
  botProtection: z.boolean().optional(),
  // Above ~30s a genuine customer filling a short form starts tripping it.
  minFillSeconds: z.number().int().min(0).max(30).optional(),
});

export type UpdateFormInput = z.infer<typeof UpdateFormSchema>;

/**
 * Replaces the entire field list in one request.
 *
 * Whole-list rather than per-field PATCH because the builder is a drag-and-drop
 * surface: a single drag changes the position of every field between the source
 * and the destination. Sending those as individual updates would be a burst of
 * requests that can interleave and land out of order, leaving the form in a
 * state the merchant never arranged.
 */
export const ReplaceFieldsSchema = z.object({
  // Ordered as the merchant arranged them; positions are assigned server-side.
  fields: z.array(FormFieldInputSchema).min(1).max(60),
});

export type ReplaceFieldsInput = z.infer<typeof ReplaceFieldsSchema>;

export const FormIdParamSchema = z.object({
  formId: z.string().cuid(),
});

export type FormIdParam = z.infer<typeof FormIdParamSchema>;

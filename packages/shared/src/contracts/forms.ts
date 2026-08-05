import type { FormFieldType, Locale } from '../enums.js';

/**
 * The COD form contract.
 *
 * One definition serves three consumers, which is why it lives here rather than
 * in any of them:
 *
 *   - the **admin builder**, which edits it
 *   - the **storefront renderer**, which draws it and validates against it
 *   - the **API**, which re-validates every submission against the same rules
 *
 * That last one is the reason the validation rules are data rather than code.
 * A merchant's regex or minimum length has to produce identical verdicts in the
 * browser and on the server; expressing them as a shared structure and running
 * one shared evaluator over it is the only way to guarantee that.
 */

/** One option in a SELECT, MULTISELECT or RADIO field. */
export interface FieldOption {
  readonly label: string;
  readonly value: string;
  /** Per-locale label overrides, keyed by lowercase BCP 47 language. */
  readonly translations?: Readonly<Record<string, string>>;
}

/**
 * Comparison operators available to conditional visibility rules.
 *
 * Deliberately small. Every operator here has an unambiguous meaning across
 * strings, numbers and arrays, which matters because a merchant builds these in
 * a dropdown without knowing the underlying type of the field they reference.
 */
export const ConditionOperator = {
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  CONTAINS: 'contains',
  NOT_CONTAINS: 'not_contains',
  IN: 'in',
  NOT_IN: 'not_in',
  GREATER_THAN: 'gt',
  LESS_THAN: 'lt',
  GREATER_OR_EQUAL: 'gte',
  LESS_OR_EQUAL: 'lte',
  IS_EMPTY: 'is_empty',
  IS_NOT_EMPTY: 'is_not_empty',
} as const;

export type ConditionOperator = (typeof ConditionOperator)[keyof typeof ConditionOperator];

/** Operators that take no right-hand value. */
export const UNARY_OPERATORS: readonly ConditionOperator[] = [
  ConditionOperator.IS_EMPTY,
  ConditionOperator.IS_NOT_EMPTY,
];

/**
 * A single visibility condition: "show this field when `field` `operator`
 * `value`".
 *
 * `field` is another field's `key` in the same form. Chains are permitted — a
 * field may depend on one that is itself conditional — and the evaluator
 * resolves them by treating a hidden field as having no value, so a dependent
 * of a hidden field is hidden too.
 */
export interface FieldCondition {
  readonly field: string;
  readonly operator: ConditionOperator;
  readonly value?: string | number | boolean | readonly string[];
}

/**
 * How multiple conditions combine.
 *
 * Two flat lists rather than an arbitrary boolean tree: a tree is far harder to
 * express in a drag-and-drop builder than it is worth, and in practice
 * "all of these" or "any of these" covers what merchants actually build.
 */
export interface FieldConditionalRule {
  readonly logic: 'all' | 'any';
  readonly conditions: readonly FieldCondition[];
}

/** Validation constraints attached to one field. */
export interface FieldValidation {
  readonly required: boolean;
  readonly minLength?: number | null;
  readonly maxLength?: number | null;
  readonly minValue?: number | null;
  readonly maxValue?: number | null;
  /**
   * JavaScript-compatible regular expression **source**, without delimiters or
   * flags. Validated server-side before it is ever persisted — an unbounded
   * merchant-authored pattern is a denial-of-service risk against both the
   * shopper's browser and the API.
   */
  readonly pattern?: string | null;
  /** Shown instead of the generated message when any constraint fails. */
  readonly message?: string | null;
}

/** A field as the storefront and the builder both see it. */
export interface FormFieldDefinition {
  readonly id: string;
  /** Stable machine key. Becomes the submission property and the Sheets column. */
  readonly key: string;
  readonly type: FormFieldType;
  readonly label: string;
  readonly placeholder: string | null;
  readonly helpText: string | null;
  readonly position: number;

  readonly enabled: boolean;
  /** System fields may be reordered, relabelled and disabled — never deleted. */
  readonly system: boolean;
  /** Rendered but not shown. Carries attribution values such as UTM parameters. */
  readonly hidden: boolean;
  readonly defaultValue: string | null;

  readonly validation: FieldValidation;
  readonly options: readonly FieldOption[];
  readonly conditional: FieldConditionalRule | null;

  /** 1–12, on a twelve-column grid. */
  readonly columnWidth: number;
  readonly cssClass: string | null;
  /** Per-locale overrides of label, placeholder and helpText. */
  readonly translations: Readonly<Record<string, Partial<Record<'label' | 'placeholder' | 'helpText', string>>>>;
}

/** Copy and behaviour of the form as a whole. */
export interface FormDefinition {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly isDefault: boolean;

  readonly headingText: string;
  readonly subheadingText: string | null;
  readonly submitButtonText: string;
  readonly successMessage: string;
  readonly translations: Readonly<Record<string, Record<string, string>>>;

  readonly layout: 'single_column' | 'two_column';
  readonly showOrderSummary: boolean;
  readonly showProductImage: boolean;
  readonly showQuantitySelector: boolean;
  readonly showVariantSelector: boolean;
  readonly showCouponField: boolean;
  readonly showTermsCheckbox: boolean;
  readonly termsUrl: string | null;

  readonly requireOtp: boolean;
  readonly trackAbandonment: boolean;
  readonly abandonmentDelaySeconds: number;
  /**
   * Honeypot and fill-timing checks. Cheap, and they stop the overwhelming
   * majority of automated COD spam without putting a CAPTCHA in front of a
   * paying customer.
   */
  readonly botProtection: boolean;
  readonly minFillSeconds: number;

  readonly fields: readonly FormFieldDefinition[];
}

/** Response body of the public form endpoint. */
export interface StorefrontFormResponse {
  readonly form: FormDefinition;
  readonly locale: Locale;
  /**
   * Signed, short-lived token issued with the form and required on submission.
   * Ties a submission to a form that was genuinely served, which is what stops
   * a script from posting straight at the order endpoint.
   */
  readonly formToken: string;
}

/** Name of the honeypot input. Must match between renderer and validator. */
export const HONEYPOT_FIELD_NAME = 'codflow_hp' as const;

/** Hidden input carrying the render timestamp, for the fill-time check. */
export const RENDER_TIMESTAMP_FIELD_NAME = 'codflow_ts' as const;

/**
 * Field types that render as presentation only.
 *
 * They never produce a value, are never required, and are skipped entirely by
 * the validator — a HEADING with `required: true` would otherwise make a form
 * impossible to submit.
 *
 * Re-exported from `enums.ts`, which owns the list, rather than restated here:
 * two copies of this set would eventually disagree, and the failure mode is a
 * form that cannot be submitted.
 */
export { PRESENTATIONAL_FIELD_TYPES as PRESENTATIONAL_TYPES } from '../enums.js';

/** Field types whose value is a list rather than a scalar. */
export const MULTI_VALUE_TYPES: readonly FormFieldType[] = ['MULTISELECT'];

/** Field types that carry a numeric value. */
export const NUMERIC_TYPES: readonly FormFieldType[] = ['NUMBER', 'QUANTITY'];

/** Field types whose value must be one of the configured options. */
export const OPTION_TYPES: readonly FormFieldType[] = ['SELECT', 'MULTISELECT', 'RADIO'];

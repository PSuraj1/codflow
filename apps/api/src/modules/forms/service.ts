import {
  PLAN_LIMITS,
  PRESENTATIONAL_TYPES,
  REQUIRED_FORM_FIELD_KEY,
  UNARY_OPERATORS,
  type FormDefinition,
  type Plan,
} from '@codflow/shared';
import { invalidateTag, shopTag } from '../../lib/cache';
import { createLogger } from '../../lib/logger';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { AppError, ErrorCode } from '../../lib/errors';
import { DEFAULT_FORM_FIELDS, FIELD_POSITION_STEP } from '../shop/defaults';
import * as repository from './repository';
import { toFormDefinition } from './mapper';
import type { CreateFormInput, FormFieldInput, ReplaceFieldsInput, UpdateFormInput } from './dto';

const log = createLogger('forms-service');

/**
 * Form builder business rules.
 *
 * The DTO layer has already checked that each value is *well-formed*. This
 * layer checks that the arrangement is *coherent* — which is a different
 * question and one that needs the whole form in view: a regex is valid on its
 * own but a conditional rule pointing at a deleted field is not, and neither is
 * a form that has lost its phone field.
 */

/** Cross-field checks that only make sense against the complete list. */
function validateArrangement(fields: FormFieldInput[]): void {
  const errors: Record<string, string[]> = {};
  const add = (path: string, message: string) => {
    (errors[path] ??= []).push(message);
  };

  // ---- Keys must be unique. A duplicate would make one field's value
  // overwrite the other's on submission, losing data silently.
  const seen = new Map<string, number>();
  for (const [index, field] of fields.entries()) {
    const previous = seen.get(field.key);
    if (previous !== undefined) {
      add(`fields.${index}.key`, `Duplicate key "${field.key}" — also used by field ${previous + 1}`);
    }
    seen.set(field.key, index);
  }

  const keys = new Set(fields.map((field) => field.key));

  for (const [index, field] of fields.entries()) {
    // ---- Option-backed types need options, or the shopper sees an empty
    // dropdown they cannot satisfy a `required` rule with.
    const needsOptions = field.type === 'SELECT' || field.type === 'RADIO' || field.type === 'MULTISELECT';

    if (needsOptions && field.options.length === 0) {
      add(`fields.${index}.options`, `${field.label} needs at least one option`);
    }

    if (needsOptions) {
      const values = new Set<string>();
      for (const option of field.options) {
        if (values.has(option.value)) {
          add(`fields.${index}.options`, `Duplicate option value "${option.value}"`);
        }
        values.add(option.value);
      }
    }

    // ---- Presentational fields carry no value, so a validation rule on one is
    // either a no-op or a trap. Rejecting it keeps the builder honest.
    if (PRESENTATIONAL_TYPES.includes(field.type) && field.validation.required) {
      add(`fields.${index}.validation.required`, `${field.type} fields cannot be required`);
    }

    // ---- Conditional references
    if (field.conditional) {
      for (const [conditionIndex, condition] of field.conditional.conditions.entries()) {
        const path = `fields.${index}.conditional.conditions.${conditionIndex}.field`;

        if (condition.field === field.key) {
          add(path, 'A field cannot depend on itself');
          continue;
        }

        if (!keys.has(condition.field)) {
          add(path, `No field named "${condition.field}" in this form`);
        }

        if (
          !UNARY_OPERATORS.includes(condition.operator as never) &&
          condition.value === undefined
        ) {
          add(path, `Operator "${condition.operator}" needs a value`);
        }
      }
    }
  }

  // ---- The one field a COD order cannot be created without.
  const phone = fields.find((field) => field.key === REQUIRED_FORM_FIELD_KEY);

  if (!phone) {
    add('fields', 'The phone field cannot be removed — COD orders are confirmed by phone');
  } else if (!phone.enabled) {
    add('fields', 'The phone field cannot be disabled — COD orders are confirmed by phone');
  } else if (!phone.validation.required) {
    add('fields', 'The phone field must stay required');
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('This form arrangement has problems', { details: errors });
  }
}

/**
 * System fields may be reordered, relabelled and restyled — never deleted, and
 * never re-keyed or retyped. The order pipeline reads them by `key` and assumes
 * their type, so a merchant renaming `phone` to `mobile` would break order
 * creation rather than just the form.
 */
async function assertSystemFieldsIntact(formId: string, fields: FormFieldInput[]): Promise<void> {
  const existing = await repository.findFieldKeys(formId);
  const systemKeys = existing.filter((field) => field.isSystem).map((field) => field.key);
  const submitted = new Set(fields.map((field) => field.key));

  const missing = systemKeys.filter((key) => !submitted.has(key));

  if (missing.length > 0) {
    throw new ValidationError('Built-in fields cannot be deleted', {
      details: {
        fields: [
          `These fields are required by the order pipeline and can only be hidden, ` +
            `not removed: ${missing.join(', ')}`,
        ],
      },
    });
  }

  // A system field must keep the type the pipeline expects.
  const defaults = new Map(DEFAULT_FORM_FIELDS.map((field) => [field.key, field.type]));

  for (const [index, field] of fields.entries()) {
    const expectedType = defaults.get(field.key);
    const isSystem = systemKeys.includes(field.key);

    if (isSystem && expectedType && field.type !== expectedType) {
      throw new ValidationError('Built-in fields cannot change type', {
        details: {
          [`fields.${index}.type`]: [`"${field.key}" must stay a ${expectedType} field`],
        },
      });
    }
  }
}

/**
 * Storefront config embeds the active form's id and OTP flag, so any change
 * here has to reach shoppers rather than waiting out the cache TTL.
 */
async function invalidateStorefront(shopDomain: string): Promise<void> {
  await invalidateTag(shopTag(shopDomain));
}

export async function listForms(shopId: string): Promise<FormDefinition[]> {
  const forms = await repository.listForms(shopId);
  return forms.map(toFormDefinition);
}

export async function getForm(shopId: string, formId: string): Promise<FormDefinition> {
  const form = await repository.findById(shopId, formId);
  if (!form) throw new NotFoundError('Form not found');
  return toFormDefinition(form);
}

export async function getActiveForm(shopId: string): Promise<FormDefinition | null> {
  const form = await repository.findActive(shopId);
  return form ? toFormDefinition(form) : null;
}

/**
 * Creates a form seeded with the default field set.
 *
 * A blank form would be a worse starting point than it looks: the merchant
 * would have to rebuild the address fields by hand, and any field they named
 * differently from the pipeline's expectations would not map onto an order.
 */
export async function createForm(
  shopId: string,
  plan: Plan,
  input: CreateFormInput,
): Promise<FormDefinition> {
  const limit = PLAN_LIMITS[plan].forms;

  if (limit !== null) {
    const count = await repository.countForms(shopId);

    if (count >= limit) {
      throw new AppError(
        `Your plan includes ${limit} form${limit === 1 ? '' : 's'}. Upgrade to add more.`,
        403,
        ErrorCode.PLAN_LIMIT_REACHED,
        { details: { limit, current: count, resource: 'forms' } },
      );
    }
  }

  try {
    const form = await repository.create(shopId, {
      name: input.name,
      headingText: input.headingText,
      subheadingText: input.subheadingText ?? null,
      submitButtonText: input.submitButtonText,
      successMessage: input.successMessage,
      // New forms start inactive so building one does not replace the live form
      // mid-edit. The merchant activates it when they are ready.
      isActive: false,
      isDefault: false,
      fields: {
        create: DEFAULT_FORM_FIELDS.map((field, index) => ({
          ...field,
          position: index * FIELD_POSITION_STEP,
        })),
      },
    });

    log.info({ shopId, formId: form.id }, 'Form created');
    return toFormDefinition(form);
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ConflictError(`You already have a form named "${input.name}"`);
    }
    throw error;
  }
}

export async function updateForm(
  shopId: string,
  shopDomain: string,
  formId: string,
  input: UpdateFormInput,
): Promise<FormDefinition> {
  const existing = await repository.findById(shopId, formId);
  if (!existing) throw new NotFoundError('Form not found');

  const { active, ...rest } = input;

  try {
    await repository.update(formId, {
      ...rest,
      ...(rest.translations !== undefined
        ? { translations: rest.translations as object }
        : {}),
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new ConflictError(`You already have a form named "${input.name}"`);
    }
    throw error;
  }

  // Activation is a separate transactional operation, because it has to
  // deactivate every sibling atomically.
  if (active === true) {
    await repository.setActive(shopId, formId);
  } else if (active === false && existing.isActive) {
    throw new ValidationError(
      'A shop must always have one active form. Activate a different form instead.',
    );
  }

  await invalidateStorefront(shopDomain);

  const updated = await repository.findById(shopId, formId);
  if (!updated) throw new NotFoundError('Form not found');

  return toFormDefinition(updated);
}

export async function replaceFields(
  shopId: string,
  shopDomain: string,
  formId: string,
  input: ReplaceFieldsInput,
): Promise<FormDefinition> {
  const existing = await repository.findById(shopId, formId);
  if (!existing) throw new NotFoundError('Form not found');

  validateArrangement(input.fields);
  await assertSystemFieldsIntact(formId, input.fields);

  const updated = await repository.replaceFields(formId, input.fields);
  await invalidateStorefront(shopDomain);

  log.info({ shopId, formId, fieldCount: input.fields.length }, 'Form fields replaced');

  return toFormDefinition(updated);
}

export async function deleteForm(
  shopId: string,
  shopDomain: string,
  formId: string,
): Promise<void> {
  const form = await repository.findById(shopId, formId);
  if (!form) throw new NotFoundError('Form not found');

  if (form.isActive) {
    throw new ConflictError(
      'This is the active form. Activate a different form before deleting it.',
    );
  }

  if (form.isDefault) {
    throw new ConflictError('The default form cannot be deleted.');
  }

  await repository.remove(formId);
  await invalidateStorefront(shopDomain);

  log.info({ shopId, formId }, 'Form deleted');
}

/**
 * Copies a form, fields and all.
 *
 * The common way a merchant safely experiments: duplicate the live form, edit
 * the copy, then activate it. `isSystem` is carried across so the copy is
 * subject to the same protections as the original.
 */
export async function duplicateForm(
  shopId: string,
  plan: Plan,
  formId: string,
): Promise<FormDefinition> {
  const source = await repository.findById(shopId, formId);
  if (!source) throw new NotFoundError('Form not found');

  const limit = PLAN_LIMITS[plan].forms;

  if (limit !== null) {
    const count = await repository.countForms(shopId);
    if (count >= limit) {
      throw new AppError(
        `Your plan includes ${limit} form${limit === 1 ? '' : 's'}. Upgrade to add more.`,
        403,
        ErrorCode.PLAN_LIMIT_REACHED,
        { details: { limit, current: count, resource: 'forms' } },
      );
    }
  }

  const copy = await repository.create(shopId, {
    name: `${source.name} (copy)`.slice(0, 120),
    headingText: source.headingText,
    subheadingText: source.subheadingText,
    submitButtonText: source.submitButtonText,
    successMessage: source.successMessage,
    translations: source.translations as object,
    layout: source.layout,
    showOrderSummary: source.showOrderSummary,
    showProductImage: source.showProductImage,
    showQuantitySelector: source.showQuantitySelector,
    showVariantSelector: source.showVariantSelector,
    showCouponField: source.showCouponField,
    showTermsCheckbox: source.showTermsCheckbox,
    termsUrl: source.termsUrl,
    requireOtp: source.requireOtp,
    trackAbandonment: source.trackAbandonment,
    abandonmentDelaySeconds: source.abandonmentDelaySeconds,
    botProtection: source.botProtection,
    minFillSeconds: source.minFillSeconds,
    isActive: false,
    isDefault: false,
    fields: {
      create: source.fields.map((field) => ({
        key: field.key,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        helpText: field.helpText,
        position: field.position,
        isRequired: field.isRequired,
        isEnabled: field.isEnabled,
        isSystem: field.isSystem,
        isHidden: field.isHidden,
        defaultValue: field.defaultValue,
        minLength: field.minLength,
        maxLength: field.maxLength,
        minValue: field.minValue,
        maxValue: field.maxValue,
        regexPattern: field.regexPattern,
        validationMessage: field.validationMessage,
        options: field.options as object,
        conditionalOn: field.conditionalOn as object,
        columnWidth: field.columnWidth,
        cssClass: field.cssClass,
        translations: field.translations as object,
      })),
    },
  });

  log.info({ shopId, sourceId: formId, copyId: copy.id }, 'Form duplicated');
  return toFormDefinition(copy);
}

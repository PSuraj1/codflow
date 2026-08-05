import { Prisma, type FormConfig, type FormField } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { FIELD_POSITION_STEP } from '../shop/defaults';
import type { FormFieldInput } from './dto';

/**
 * Form persistence.
 *
 * The interesting operation is `replaceFields`. A drag-and-drop builder saves
 * the whole arrangement at once, so the write has to reconcile three sets in a
 * single transaction: fields that were added, fields that moved or changed, and
 * fields that were removed. Doing it outside a transaction would let a merchant
 * refresh mid-save and find a form missing half its fields.
 */

export type FormWithFields = FormConfig & { fields: FormField[] };

export function findById(shopId: string, formId: string): Promise<FormWithFields | null> {
  return prisma.formConfig.findFirst({
    where: { id: formId, shopId },
    include: { fields: { orderBy: { position: 'asc' } } },
  });
}

export function findActive(shopId: string): Promise<FormWithFields | null> {
  return prisma.formConfig.findFirst({
    where: { shopId, isActive: true },
    include: { fields: { orderBy: { position: 'asc' } } },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });
}

export function listForms(shopId: string): Promise<FormWithFields[]> {
  return prisma.formConfig.findMany({
    where: { shopId },
    include: { fields: { orderBy: { position: 'asc' } } },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
}

export function countForms(shopId: string): Promise<number> {
  return prisma.formConfig.count({ where: { shopId } });
}

export function create(
  shopId: string,
  data: Prisma.FormConfigCreateWithoutShopInput,
): Promise<FormWithFields> {
  return prisma.formConfig.create({
    data: { ...data, shop: { connect: { id: shopId } } },
    include: { fields: { orderBy: { position: 'asc' } } },
  });
}

export function update(
  formId: string,
  data: Prisma.FormConfigUpdateInput,
): Promise<FormWithFields> {
  return prisma.formConfig.update({
    where: { id: formId },
    data,
    include: { fields: { orderBy: { position: 'asc' } } },
  });
}

/**
 * Makes one form the shop's active form.
 *
 * Both statements run in a transaction because the invariant is "exactly one
 * active form", and between the deactivate and the activate there is a moment
 * with none. A storefront request landing in that window would find no form and
 * render nothing.
 */
export async function setActive(shopId: string, formId: string): Promise<void> {
  await prisma.$transaction([
    prisma.formConfig.updateMany({
      where: { shopId, id: { not: formId } },
      data: { isActive: false },
    }),
    prisma.formConfig.update({ where: { id: formId }, data: { isActive: true } }),
  ]);
}

export async function remove(formId: string): Promise<void> {
  // Fields cascade from the schema's `onDelete: Cascade`.
  await prisma.formConfig.delete({ where: { id: formId } });
}

/** Maps the validated input shape onto the flat column layout. */
function toFieldColumns(field: FormFieldInput, position: number) {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    placeholder: field.placeholder ?? null,
    helpText: field.helpText ?? null,
    position,
    isRequired: field.validation.required,
    isEnabled: field.enabled,
    isHidden: field.hidden,
    defaultValue: field.defaultValue ?? null,
    minLength: field.validation.minLength ?? null,
    maxLength: field.validation.maxLength ?? null,
    minValue: field.validation.minValue ?? null,
    maxValue: field.validation.maxValue ?? null,
    regexPattern: field.validation.pattern ?? null,
    validationMessage: field.validation.message ?? null,
    options: field.options as unknown as Prisma.InputJsonValue,
    conditionalOn: (field.conditional ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    columnWidth: field.columnWidth,
    cssClass: field.cssClass ?? null,
    translations: field.translations as unknown as Prisma.InputJsonValue,
  };
}

/**
 * Replaces a form's field list.
 *
 * `isSystem` is never taken from the request — it is read from the existing row
 * and preserved. Trusting the client with it would let a merchant clear the
 * flag on `phone` and then delete the one field a COD order cannot exist
 * without.
 *
 * Positions are assigned from array order in steps of 10, so a later
 * single-field insert can be placed between two neighbours without rewriting
 * every sibling.
 */
export async function replaceFields(
  formId: string,
  fields: FormFieldInput[],
): Promise<FormWithFields> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.formField.findMany({
      where: { formConfigId: formId },
      select: { id: true, key: true, isSystem: true },
    });

    const existingById = new Map(existing.map((field) => [field.id, field]));
    const keptIds = new Set(
      fields.map((field) => field.id).filter((id): id is string => Boolean(id)),
    );

    const removed = existing.filter((field) => !keptIds.has(field.id));

    if (removed.length > 0) {
      await tx.formField.deleteMany({ where: { id: { in: removed.map((f) => f.id) } } });
    }

    for (const [index, field] of fields.entries()) {
      const position = index * FIELD_POSITION_STEP;
      const columns = toFieldColumns(field, position);
      const prior = field.id ? existingById.get(field.id) : undefined;

      if (prior) {
        await tx.formField.update({
          where: { id: prior.id },
          // `isSystem` deliberately absent — it is not the client's to set.
          data: columns,
        });
      } else {
        await tx.formField.create({
          data: { ...columns, formConfigId: formId, isSystem: false },
        });
      }
    }

    const result = await tx.formConfig.findUniqueOrThrow({
      where: { id: formId },
      include: { fields: { orderBy: { position: 'asc' } } },
    });

    return result;
  });
}

/** Field keys currently defined on a form, for reference checks. */
export function findFieldKeys(formId: string): Promise<{ key: string; isSystem: boolean }[]> {
  return prisma.formField.findMany({
    where: { formConfigId: formId },
    select: { key: true, isSystem: true },
  });
}

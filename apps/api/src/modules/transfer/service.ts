import { Prisma } from '@prisma/client';
import {
  SETTINGS_EXPORT_VERSION,
  type SettingsExport,
  type SettingsImportResult,
} from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { invalidateTag, shopTag } from '../../lib/cache';
import * as repository from './repository';
import type { ImportSettingsInput } from './dto';

const log = createLogger('transfer');

/**
 * Settings backup, transfer and restore.
 *
 * Composes the other modules' data rather than owning any of it, which is why
 * it reads through its own repository with explicit column lists: the point of
 * the feature is to move *configuration*, and the boundary of what counts has
 * to be stated in one place rather than inferred from whatever each module
 * happens to expose.
 */

/**
 * Prisma `Decimal` and `Date` do not survive `JSON.stringify` as anything
 * useful — a Decimal serialises to an object, which then fails import
 * validation that expects a decimal string. Converting on the way out keeps the
 * file readable and round-trippable.
 */
function toJsonValue(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function plain(row: Record<string, unknown> | null): Record<string, unknown> {
  if (!row) return {};

  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toJsonValue(value)]));
}

/** Everything a merchant's configuration consists of, as one file. */
export async function exportSettings(
  shopId: string,
  shopDomain: string,
): Promise<SettingsExport> {
  const [settings, buttons, forms, fraud, fraudRules] = await Promise.all([
    repository.findSettings(shopId),
    repository.findButtons(shopId),
    repository.findForms(shopId),
    repository.findFraud(shopId),
    repository.findFraudRules(shopId),
  ]);

  if (!settings) throw new NotFoundError('This shop has no settings record');

  log.info({ shopId, buttons: buttons.length, forms: forms.length }, 'Settings exported');

  return {
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    shopDomain,
    settings: plain(settings as Record<string, unknown>),
    buttons: buttons.map((button) => plain(button as Record<string, unknown>)),
    forms: forms.map((form) => ({
      ...plain(form as unknown as Record<string, unknown>),
      fields: (form.fields as unknown as Record<string, unknown>[]).map((field) => plain(field)),
    })),
    fraud: fraud ? plain(fraud as Record<string, unknown>) : null,
    fraudRules: fraudRules.map((rule) => plain(rule as Record<string, unknown>)),
  };
}

/** Drops keys the file omitted, so an absent field means "leave it alone". */
function defined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/**
 * Applies a settings file to the authenticated shop.
 *
 * The shop written to is always the caller's — `shopDomain` in the file is
 * provenance a merchant can read, never a target. That is what makes it safe
 * for one merchant to send another their configuration.
 *
 * Order matters: settings first, then the things that reference them. A failure
 * part-way leaves the earlier sections applied, which is deliberate — a partial
 * restore a merchant can see and finish beats an all-or-nothing transaction
 * that rolls back the twenty screens that were fine because the twenty-first
 * had a bad colour.
 */
export async function importSettings(
  shopId: string,
  shopDomain: string,
  input: ImportSettingsInput,
): Promise<SettingsImportResult> {
  if (input.version !== SETTINGS_EXPORT_VERSION) {
    throw new ValidationError(
      `This file was made by a different version of CODkar (v${input.version}). ` +
        `This version reads v${SETTINGS_EXPORT_VERSION}.`,
    );
  }

  const skipped: string[] = [];

  // ---- Shop settings
  let appliedSettings = false;

  if (input.settings) {
    const data = defined(input.settings as Record<string, unknown>);

    if (Object.keys(data).length > 0) {
      await repository.updateSettings(shopId, data as never);
      appliedSettings = true;
    }
  }

  // ---- Buttons
  let buttons = 0;

  for (const button of input.buttons ?? []) {
    const { placement, ...rest } = button;
    const data = defined(rest as Record<string, unknown>);

    await repository.upsertButton(shopId, placement, data as never);
    buttons += 1;
  }

  // ---- Forms
  let forms = 0;

  for (const form of input.forms ?? []) {
    const { name, fields, ...rest } = form;
    const data = defined(rest as Record<string, unknown>);

    await repository.replaceFormFields(
      shopId,
      name,
      data as never,
      (fields ?? []).map((field) => defined(field as Record<string, unknown>)) as never,
    );
    forms += 1;
  }

  // ---- Fraud
  let appliedFraud = false;

  if (input.fraud) {
    const data = defined(input.fraud as Record<string, unknown>);

    if (Object.keys(data).length > 0) {
      await repository.upsertFraudSettings(shopId, data as never);
      appliedFraud = true;
    }
  }

  let fraudRules = 0;

  if (input.fraudRules) {
    fraudRules = await repository.replaceFraudRules(
      shopId,
      input.fraudRules.map((rule) => ({
        ...defined(rule as Record<string, unknown>),
        shopId,
      })) as never,
    );
  }

  /**
   * Said out loud rather than logged. A merchant restoring onto a *different*
   * store has product and collection rules pointing at ids that do not exist
   * there, and the symptom — COD silently not offered — looks nothing like the
   * cause.
   */
  const settings = input.settings;
  const carriesGids =
    (settings?.includedProductGids?.length ?? 0) > 0 ||
    (settings?.excludedProductGids?.length ?? 0) > 0 ||
    (settings?.includedCollectionGids?.length ?? 0) > 0;

  if (carriesGids && input.shopDomain && input.shopDomain !== shopDomain) {
    skipped.push(
      'Product and collection rules were imported but reference the store they came from. ' +
        'Check them under Visibility.',
    );
  }

  skipped.push('Ad pixels and Google Sheets are never included — reconnect them on this store.');

  // The storefront config embeds most of this, so a restore that skipped the
  // invalidation would leave a merchant reloading their storefront and seeing
  // the settings they just replaced.
  await invalidateTag(shopTag(shopDomain));

  log.warn(
    { shopId, buttons, forms, fraudRules, settings: appliedSettings },
    'Settings imported from a file',
  );

  return { settings: appliedSettings, buttons, forms, fraud: appliedFraud, fraudRules, skipped };
}

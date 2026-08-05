import type { ButtonConfig, ButtonPlacement } from '@prisma/client';
import {
  CUSTOMIZABLE_BUTTON_PLACEMENTS,
  type ButtonAnimation,
  type ButtonConfigSummary,
  type ButtonFontWeight,
  type CustomizableButtonPlacement,
  type FloatingPosition,
} from '@codflow/shared';
import { invalidateTag, shopTag } from '../../lib/cache';
import { createLogger } from '../../lib/logger';
import { ValidationError } from '../../lib/errors';
import { assertFeature } from '../billing/limits';
import { DEFAULT_BUTTON_STYLE } from '../shop/defaults';
import * as repository from './repository';
import type { UpdateButtonInput } from './dto';

const log = createLogger('buttons-service');

/**
 * COD button configuration.
 *
 * Two rules shape this module.
 *
 * **Every renderable placement is always listed**, whether or not a row exists.
 * Install seeds four of the six, so a merchant who drags the app block onto
 * their home page and picks "Home page" has a slot that never fills and nothing
 * in the admin to fix it. Synthesizing the missing two — disabled, because a
 * missing row genuinely renders nothing — makes them configurable, and the
 * first save creates the row.
 *
 * **A save writes the whole record**, not the patch. See `repository.upsertButton`.
 */

/**
 * The record shown for a placement the merchant has never configured.
 *
 * Reached only by `COLLECTION_PAGE` and `HOME_PAGE`: the other four are created
 * at provisioning from `DEFAULT_BUTTON_CONFIGS`.
 */
function defaultsFor(placement: CustomizableButtonPlacement): ButtonConfigSummary {
  return {
    ...DEFAULT_BUTTON_STYLE,
    placement,
    // Not the schema's `true`. Without a row the storefront query returns
    // nothing for this placement, so `false` is what the shopper is seeing.
    isEnabled: false,
  };
}

/**
 * Widens the columns the database stores as free text back into the unions the
 * contract declares. Every write goes through the DTO, so anything already
 * persisted came from one of these sets.
 */
function toSummary(record: ButtonConfig): ButtonConfigSummary {
  return {
    placement: record.placement as CustomizableButtonPlacement,
    isEnabled: record.isEnabled,
    label: record.label,
    subLabel: record.subLabel,
    bgColor: record.bgColor,
    textColor: record.textColor,
    borderColor: record.borderColor,
    borderRadius: record.borderRadius,
    fontSize: record.fontSize,
    fontWeight: record.fontWeight as ButtonFontWeight,
    paddingY: record.paddingY,
    paddingX: record.paddingX,
    fullWidth: record.fullWidth,
    customCss: record.customCss,
    showOnMobile: record.showOnMobile,
    showOnDesktop: record.showOnDesktop,
    showAfterScrollPx: record.showAfterScrollPx,
    stickyOffsetBottom: record.stickyOffsetBottom,
    floatingPosition: record.floatingPosition as FloatingPosition,
    animation: record.animation as ButtonAnimation,
  };
}

/**
 * Every renderable placement, in the order the customizer shows them.
 *
 * Product page first because it is the one that converts. `POPUP` rows, if any
 * exist, are dropped: nothing renders that placement.
 */
export async function listButtons(shopId: string): Promise<ButtonConfigSummary[]> {
  const rows = await repository.listButtons(shopId);
  const byPlacement = new Map(rows.map((row) => [row.placement as string, row]));

  return CUSTOMIZABLE_BUTTON_PLACEMENTS.map((placement) => {
    const row = byPlacement.get(placement);
    return row ? toSummary(row) : defaultsFor(placement);
  });
}

export async function getButton(
  shopId: string,
  placement: CustomizableButtonPlacement,
): Promise<ButtonConfigSummary> {
  const row = await repository.findButton(shopId, placement as ButtonPlacement);
  return row ? toSummary(row) : defaultsFor(placement);
}

/**
 * Cross-field checks, against the merged record rather than the patch.
 *
 * A merchant turning off "show on desktop" for a button that was already hidden
 * on mobile has built something that renders nowhere, and the theme gives no
 * hint why — `isVisibleForViewport` simply returns false and the button never
 * appears. Refusing is kinder than a support ticket.
 */
function assertVisible(merged: ButtonConfigSummary): void {
  if (merged.isEnabled && !merged.showOnMobile && !merged.showOnDesktop) {
    throw new ValidationError(
      'This button is on but hidden on both mobile and desktop, so it would never appear. ' +
        'Show it on at least one, or switch the button off.',
    );
  }
}

export async function updateButton(
  shopId: string,
  shopDomain: string,
  placement: CustomizableButtonPlacement,
  input: UpdateButtonInput,
): Promise<ButtonConfigSummary> {
  const current = await getButton(shopId, placement);

  const merged: ButtonConfigSummary = {
    ...current,
    ...input,
    // An emptied textarea arrives as `''`, which would store a stylesheet that
    // is present but blank — and then be served to every shopper as an empty
    // `<style>` element rather than no element at all.
    customCss:
      input.customCss === undefined
        ? current.customCss
        : (input.customCss?.trim() ?? '') === ''
          ? null
          : input.customCss,
    subLabel:
      input.subLabel === undefined
        ? current.subLabel
        : (input.subLabel?.trim() ?? '') === ''
          ? null
          : input.subLabel,
    placement,
  };

  // Gated on the change rather than on the value: a merchant who downgrades
  // keeps their CSS — the storefront stops serving it, `toButton` sees to that
  // — and can still edit their label without being refused for a field they
  // did not touch.
  if (merged.customCss !== null && merged.customCss !== current.customCss) {
    await assertFeature(shopId, 'customCss');
  }

  assertVisible(merged);

  const saved = await repository.upsertButton(shopId, placement as ButtonPlacement, {
    isEnabled: merged.isEnabled,
    label: merged.label,
    subLabel: merged.subLabel,
    bgColor: merged.bgColor,
    textColor: merged.textColor,
    borderColor: merged.borderColor,
    borderRadius: merged.borderRadius,
    fontSize: merged.fontSize,
    fontWeight: merged.fontWeight,
    paddingY: merged.paddingY,
    paddingX: merged.paddingX,
    fullWidth: merged.fullWidth,
    customCss: merged.customCss,
    showOnMobile: merged.showOnMobile,
    showOnDesktop: merged.showOnDesktop,
    showAfterScrollPx: merged.showAfterScrollPx,
    stickyOffsetBottom: merged.stickyOffsetBottom,
    floatingPosition: merged.floatingPosition,
    animation: merged.animation,
  });

  // The storefront config embeds every enabled button, so a change here has to
  // reach shoppers rather than waiting out the five-minute cache.
  await invalidateTag(shopTag(shopDomain));

  log.info({ shopId, placement, isEnabled: saved.isEnabled }, 'Button configuration saved');

  return toSummary(saved);
}

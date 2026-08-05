import type { ButtonPlacement } from '../enums.js';

/**
 * The COD button contract, shared by the admin customizer and the API.
 *
 * `ButtonPlacement` in `enums.ts` mirrors the database, and the database is
 * wider than reality: `POPUP` has a column value and nothing that renders it.
 * This file narrows that enum to the placements a shopper can actually see, so
 * the customizer cannot offer a merchant a knob with no effect — which is the
 * failure mode that turns "I configured it and nothing happened" into a support
 * ticket.
 *
 * Four of them come from the `cod-button` app block's own placement setting;
 * the other two are appended to `<body>` by the theme extension because no
 * theme has a slot for a sticky bar or a floating pill.
 */

/** Placements the storefront renders. The customizer covers exactly these. */
export const CUSTOMIZABLE_BUTTON_PLACEMENTS = [
  'PRODUCT_PAGE',
  'CART_PAGE',
  'COLLECTION_PAGE',
  'HOME_PAGE',
  'STICKY_MOBILE',
  'FLOATING',
] as const satisfies readonly ButtonPlacement[];

export type CustomizableButtonPlacement = (typeof CUSTOMIZABLE_BUTTON_PLACEMENTS)[number];

/**
 * Placements the theme injects rather than slots into merchant markup.
 *
 * They are the only two that own a scroll threshold and a bottom offset: a
 * button sitting inside a product form has no scroll behaviour to configure,
 * and offering one would be a control that does nothing.
 */
export const INJECTED_BUTTON_PLACEMENTS = ['STICKY_MOBILE', 'FLOATING'] as const;

/** Matches the `codflow-button--anim-*` classes in the extension's stylesheet. */
export const BUTTON_ANIMATIONS = ['none', 'pulse', 'shake'] as const;
export type ButtonAnimation = (typeof BUTTON_ANIMATIONS)[number];

/** Matches the `[data-position]` selectors the floating host is styled by. */
export const FLOATING_POSITIONS = ['bottom_right', 'bottom_left'] as const;
export type FloatingPosition = (typeof FLOATING_POSITIONS)[number];

/**
 * Weights offered rather than a free number.
 *
 * The value lands in `--codflow-font-weight`, and most storefront fonts ship
 * four weights at most — a merchant choosing 350 gets whatever the browser
 * decides to synthesize.
 */
export const BUTTON_FONT_WEIGHTS = ['400', '500', '600', '700'] as const;
export type ButtonFontWeight = (typeof BUTTON_FONT_WEIGHTS)[number];

/**
 * One placement's configuration, as the merchant sees it.
 *
 * A superset of `StorefrontButton` minus the fields nothing honours yet, and
 * unlike that type it is returned for placements with no row at all — the
 * customizer shows every placement, and a merchant cannot configure something
 * they cannot see. `isEnabled: false` on such a placement is not a guess: a
 * missing row renders nothing.
 */
export interface ButtonConfigSummary {
  readonly placement: CustomizableButtonPlacement;
  readonly isEnabled: boolean;

  readonly label: string;
  readonly subLabel: string | null;

  readonly bgColor: string;
  readonly textColor: string;
  readonly borderColor: string;
  readonly borderRadius: number;
  readonly fontSize: number;
  readonly fontWeight: ButtonFontWeight;
  readonly paddingY: number;
  readonly paddingX: number;
  readonly fullWidth: boolean;
  /**
   * Merchant-authored CSS. Present here on every plan — it is the merchant's
   * own data — but the storefront withholds it on plans without the feature,
   * so a downgrade suspends it rather than deleting it.
   */
  readonly customCss: string | null;

  readonly showOnMobile: boolean;
  readonly showOnDesktop: boolean;
  readonly showAfterScrollPx: number;
  readonly stickyOffsetBottom: number;
  readonly floatingPosition: FloatingPosition;
  readonly animation: ButtonAnimation;
}

/** Body of `PATCH /api/admin/buttons/:placement`. Every field is optional. */
export type UpdateButtonConfig = Partial<Omit<ButtonConfigSummary, 'placement'>>;

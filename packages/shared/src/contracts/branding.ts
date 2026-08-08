import type { ThemeMode } from '../enums.js';

/**
 * Shop-level appearance.
 *
 * These values style the COD form and anything a button does not override —
 * `ButtonConfig` carries its own colours, so a merchant who has customised a
 * button will not see these apply there. That precedence is deliberate: the
 * button is the thing they tuned most recently and most specifically.
 *
 * The storefront has honoured all of it since the form was built. Nothing in
 * the admin could change any of it until now, so every shop rendered CODkar's
 * default green.
 */
/**
 * Where the logo sits above the form heading.
 *
 * Three values rather than free-form CSS, because this reaches the storefront
 * as a class name. A merchant who wants something else has Custom CSS.
 */
export const LOGO_ALIGNMENTS = ['left', 'center', 'right'] as const;

export type LogoAlignment = (typeof LOGO_ALIGNMENTS)[number];

/**
 * Bounds on the logo's rendered height, in pixels.
 *
 * The floor keeps a logo legible; the ceiling keeps it from pushing the form's
 * first field below the fold on a phone, which is where most COD orders are
 * placed. Enforced in `shop/dto.ts` and mirrored by the admin's slider.
 */
export const LOGO_HEIGHT_MIN = 16;
export const LOGO_HEIGHT_MAX = 120;
export const LOGO_HEIGHT_DEFAULT = 40;

export interface ShopBrandingSummary {
  /** Buttons, focus rings, and the form's accent. */
  readonly primaryColor: string;
  /** Hover and pressed states derived from the primary. */
  readonly secondaryColor: string;
  readonly textColor: string;
  /** A CSS font stack, or `inherit` to take the theme's. */
  readonly fontFamily: string;
  readonly borderRadius: number;
  readonly logoUrl: string | null;
  /** Rendered height of the logo in pixels. Its width follows from the ratio. */
  readonly logoHeight: number;
  readonly logoAlignment: LogoAlignment;
  /**
   * Merchant-authored CSS for the form. Paid feature; the storefront withholds
   * it on plans without it rather than deleting it, so a downgrade suspends it.
   */
  readonly customCss: string | null;
  readonly themeMode: ThemeMode;
}

/** Body of `PATCH /api/admin/shop/branding`. Every field optional. */
export type UpdateShopBranding = Partial<ShopBrandingSummary>;

/**
 * Font stacks offered in the admin.
 *
 * A free-text font field produces forms that render in the merchant's chosen
 * font on their machine and a fallback everywhere else, because the file is not
 * served by the storefront. `inherit` is first and is the right answer for most
 * shops: it picks up whatever the theme already loaded.
 */
export const BRAND_FONT_STACKS = [
  { label: "Match my theme", value: 'inherit' },
  { label: 'System sans-serif', value: 'system-ui, -apple-system, sans-serif' },
  { label: 'System serif', value: 'Georgia, Cambria, serif' },
  { label: 'Monospace', value: 'ui-monospace, SFMono-Regular, monospace' },
] as const;

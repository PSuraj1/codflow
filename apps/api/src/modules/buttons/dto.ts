import { z } from 'zod';
import {
  BUTTON_ANIMATIONS,
  BUTTON_FONT_WEIGHTS,
  CUSTOMIZABLE_BUTTON_PLACEMENTS,
  FLOATING_POSITIONS,
} from '@codflow/shared';

/**
 * COD button input validation.
 *
 * The colours are the part worth guarding. Every one of them is written by the
 * theme extension into a `style` attribute as a CSS custom property —
 * `--codflow-bg:` + the stored value — so a merchant (or anyone who reached
 * this endpoint) saving `red;position:fixed;inset:0` would paint arbitrary
 * declarations over their own storefront. Restricting to a hex literal removes
 * the question rather than trying to sanitize it.
 *
 * Only well-formedness lives here. Whether the *combination* makes sense — a
 * button switched on but hidden on every viewport — needs the merged record and
 * belongs in the service, the same split the form builder uses.
 */

/** `#008060` or `#086`. Anything that could carry a `;` is refused. */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Use a hex colour such as #008060');

export const PlacementParamSchema = z.object({
  placement: z.enum(CUSTOMIZABLE_BUTTON_PLACEMENTS),
});

export type PlacementParam = z.infer<typeof PlacementParamSchema>;

export const UpdateButtonSchema = z.object({
  isEnabled: z.boolean().optional(),

  // A label longer than this wraps to three lines on a phone and stops looking
  // like a button. The sub-label is the place for a sentence.
  label: z.string().trim().min(1).max(60).optional(),
  subLabel: z.string().trim().max(80).nullish(),

  bgColor: hexColor.optional(),
  textColor: hexColor.optional(),
  borderColor: hexColor.optional(),

  borderRadius: z.number().int().min(0).max(60).optional(),
  fontSize: z.number().int().min(10).max(32).optional(),
  fontWeight: z.enum(BUTTON_FONT_WEIGHTS).optional(),
  paddingY: z.number().int().min(0).max(60).optional(),
  paddingX: z.number().int().min(0).max(80).optional(),
  fullWidth: z.boolean().optional(),

  customCss: z.string().max(5_000).nullish(),

  showOnMobile: z.boolean().optional(),
  showOnDesktop: z.boolean().optional(),

  // Generous but finite: a threshold past the length of most pages would hide
  // the button permanently, which is indistinguishable from it being broken.
  showAfterScrollPx: z.number().int().min(0).max(10_000).optional(),
  stickyOffsetBottom: z.number().int().min(0).max(400).optional(),

  floatingPosition: z.enum(FLOATING_POSITIONS).optional(),
  animation: z.enum(BUTTON_ANIMATIONS).optional(),
});

export type UpdateButtonInput = z.infer<typeof UpdateButtonSchema>;

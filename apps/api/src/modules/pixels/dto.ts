import { z } from 'zod';

/**
 * Pixel configuration contracts.
 *
 * The identifier formats are validated per provider. A merchant pasting a Meta
 * pixel id into a TikTok pixel produces a configuration that saves cleanly and
 * silently sends every conversion nowhere — and they find out weeks later from
 * their ad reporting, not from the app.
 */

const PROVIDERS = ['META', 'TIKTOK', 'GOOGLE_ADS', 'SNAPCHAT', 'PINTEREST', 'CUSTOM'] as const;

const EVENT_NAMES = [
  'PAGE_VIEW',
  'VIEW_CONTENT',
  'ADD_TO_CART',
  'INITIATE_CHECKOUT',
  'ADD_PAYMENT_INFO',
  'PURCHASE',
  'LEAD',
  'COMPLETE_REGISTRATION',
  'SEARCH',
  'CUSTOM',
] as const;

const BasePixelSchema = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().min(1).max(120),
  /** For CUSTOM this is the destination URL; for everyone else, the tag id. */
  pixelId: z.string().min(1).max(500),

  isEnabled: z.boolean().default(true),
  clientSideEnabled: z.boolean().default(true),
  serverSideEnabled: z.boolean().default(false),

  /**
   * Write-only. It is never returned — the admin shows `hasAccessToken`
   * instead — so omitting it on an update leaves the stored token untouched,
   * and an explicit null clears it.
   */
  accessToken: z.string().min(1).max(1_000).nullish(),

  testEventCode: z.string().max(120).nullish(),
  conversionId: z.string().max(120).nullish(),
  conversionLabel: z.string().max(200).nullish(),
  gtmContainerId: z.string().max(60).nullish(),

  advancedMatching: z.boolean().default(true),
  deduplication: z.boolean().default(true),
  requireConsent: z.boolean().default(true),

  /** Empty means every event the provider supports. */
  enabledEvents: z.array(z.enum(EVENT_NAMES)).max(20).default([]),

  /**
   * Only meaningful for CUSTOM, and executed inside Shopify's web pixel
   * sandbox rather than on the storefront page — it cannot reach the DOM or
   * the merchant's theme.
   */
  customScript: z.string().max(10_000).nullish(),
});

/**
 * Per-provider identifier shapes.
 *
 * Deliberately loose where a provider's format is genuinely variable, and tight
 * where it is not — a Meta pixel id is always numeric, and rejecting anything
 * else catches the paste-into-the-wrong-field mistake immediately.
 */
function validateIdentifier(
  provider: (typeof PROVIDERS)[number],
  pixelId: string,
): string | null {
  switch (provider) {
    case 'META':
      return /^\d{10,20}$/.test(pixelId)
        ? null
        : 'A Meta pixel ID is a 15–16 digit number from Events Manager.';
    case 'TIKTOK':
      return /^[A-Z0-9]{15,30}$/i.test(pixelId)
        ? null
        : 'A TikTok pixel ID is a 20-character code from Events Manager.';
    case 'SNAPCHAT':
      // A UUID.
      return /^[0-9a-f-]{30,40}$/i.test(pixelId)
        ? null
        : 'A Snapchat pixel ID looks like 00000000-0000-0000-0000-000000000000.';
    case 'PINTEREST':
      return /^\d{10,20}$/.test(pixelId) ? null : 'A Pinterest tag ID is a numeric value.';
    case 'GOOGLE_ADS':
      return /^(AW-|G-|GT-)/i.test(pixelId)
        ? null
        : 'Use your Google tag — it starts with AW-, G- or GT-.';
    case 'CUSTOM':
      return /^https:\/\//i.test(pixelId) ? null : 'A custom pixel needs an https endpoint.';
    default:
      return null;
  }
}

/**
 * `superRefine` rather than `refine`, because the message depends on which
 * provider was chosen — Zod 4 no longer accepts a function for a refinement's
 * message, so the issue has to be raised explicitly.
 */
export const CreatePixelSchema = BasePixelSchema.superRefine((input, ctx) => {
  const problem = validateIdentifier(input.provider, input.pixelId);

  if (problem) {
    ctx.addIssue({ code: 'custom', message: problem, path: ['pixelId'] });
  }
});

export type CreatePixelInput = z.infer<typeof CreatePixelSchema>;

/**
 * Partial update.
 *
 * Not `.refine`d on the identifier, because a merchant toggling
 * `isEnabled` should not have to resend a valid `pixelId` — the service
 * re-checks coherence against the stored row instead.
 */
export const UpdatePixelSchema = BasePixelSchema.partial();
export type UpdatePixelInput = z.infer<typeof UpdatePixelSchema>;

export const TestEventSchema = z.object({
  eventName: z.enum(EVENT_NAMES).default('PURCHASE'),
});

export type TestEventInput = z.infer<typeof TestEventSchema>;

export const EventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type EventsQueryInput = z.infer<typeof EventsQuerySchema>;

export const PixelIdParamSchema = z.object({ id: z.string().cuid() });

import { PROVIDER_EVENT_NAMES, type PixelEventName, type PixelProvider } from '@codflow/shared';

/**
 * What the form needs to know about each ad platform.
 *
 * The identifier hints matter more than they look. `modules/pixels/dto.ts`
 * validates the format per provider, and the whole reason it does is that a
 * Meta pixel id pasted into a TikTok pixel saves cleanly and then sends every
 * conversion nowhere — the merchant finds out weeks later from their ad
 * reporting. Showing the expected shape *before* they paste is the cheaper half
 * of that defence; the strings here mirror the server's refusal messages.
 *
 * The event vocabulary is not duplicated: `PROVIDER_EVENT_NAMES` in the shared
 * contract already maps our event names onto each provider's own, so it is the
 * source of truth for which events a provider can even receive.
 */

export interface ProviderCopy {
  readonly name: string;
  /**
   * Suggested name for the merchant's own reference.
   *
   * Per provider rather than one hardcoded string: the field is free text, and
   * a placeholder reading "Main Meta pixel" while TikTok is selected is worse
   * than no placeholder — it looks like the form did not notice the change.
   */
  readonly namePlaceholder: string;
  /** What the merchant's platform calls the identifier. */
  readonly idLabel: string;
  readonly idPlaceholder: string;
  readonly idHelp: string;
  /** Where to find it, in the platform's own words. */
  readonly whereToFind: string;
  /**
   * Whether server-side sending needs a Conversions API token.
   *
   * Google Ads carries its credential in the conversion fields and CUSTOM
   * authenticates with a request signature, so demanding a token for either
   * would block a valid setup. Mirrors `assertCoherent` in the pixels service.
   */
  readonly needsAccessToken: boolean;
  readonly supportsTestEventCode: boolean;
  readonly needsConversionFields: boolean;
  readonly supportsCustomScript: boolean;
}

export const PROVIDER_CATALOGUE: Record<PixelProvider, ProviderCopy> = {
  META: {
    name: 'Meta — Facebook and Instagram',
    namePlaceholder: 'Main Meta pixel',
    idLabel: 'Pixel ID',
    idPlaceholder: '123456789012345',
    idHelp: 'A 15–16 digit number.',
    whereToFind: 'Events Manager → Data sources → your pixel',
    needsAccessToken: true,
    supportsTestEventCode: true,
    needsConversionFields: false,
    supportsCustomScript: false,
  },
  TIKTOK: {
    name: 'TikTok',
    namePlaceholder: 'Main TikTok pixel',
    idLabel: 'Pixel ID',
    idPlaceholder: 'C4A1B2C3D4E5F6G7H8I9',
    idHelp: 'A 20-character code of letters and digits.',
    whereToFind: 'TikTok Ads Manager → Assets → Events',
    needsAccessToken: true,
    supportsTestEventCode: true,
    needsConversionFields: false,
    supportsCustomScript: false,
  },
  GOOGLE_ADS: {
    name: 'Google Ads',
    namePlaceholder: 'Google Ads conversions',
    idLabel: 'Google tag ID',
    idPlaceholder: 'AW-123456789',
    idHelp: 'Starts with AW-, G- or GT-.',
    whereToFind: 'Google Ads → Tools → Data manager',
    // The conversion id and label are the credential here.
    needsAccessToken: false,
    supportsTestEventCode: false,
    needsConversionFields: true,
    supportsCustomScript: false,
  },
  SNAPCHAT: {
    name: 'Snapchat',
    namePlaceholder: 'Main Snapchat pixel',
    idLabel: 'Pixel ID',
    idPlaceholder: '00000000-0000-0000-0000-000000000000',
    idHelp: 'A UUID.',
    whereToFind: 'Snapchat Ads Manager → Events Manager',
    needsAccessToken: true,
    supportsTestEventCode: false,
    needsConversionFields: false,
    supportsCustomScript: false,
  },
  PINTEREST: {
    name: 'Pinterest',
    namePlaceholder: 'Main Pinterest tag',
    idLabel: 'Tag ID',
    idPlaceholder: '2612345678901',
    idHelp: 'A numeric value.',
    whereToFind: 'Pinterest Ads → Conversions → Tag manager',
    needsAccessToken: true,
    supportsTestEventCode: false,
    needsConversionFields: false,
    supportsCustomScript: false,
  },
  CUSTOM: {
    name: 'Custom endpoint',
    namePlaceholder: 'My server',
    idLabel: 'Destination URL',
    idPlaceholder: 'https://example.com/events',
    idHelp: 'Must be https. Requests are signed so you can verify they came from CodFlow.',
    whereToFind: 'Your own server',
    needsAccessToken: false,
    supportsTestEventCode: false,
    needsConversionFields: false,
    supportsCustomScript: true,
  },
};

/** Providers in the order they are offered, commonest first. */
export const PROVIDER_ORDER: readonly PixelProvider[] = [
  'META',
  'GOOGLE_ADS',
  'TIKTOK',
  'SNAPCHAT',
  'PINTEREST',
  'CUSTOM',
];

/** Plain-English names for the events, for the checklist. */
export const EVENT_LABELS: Record<PixelEventName, string> = {
  PAGE_VIEW: 'Page viewed',
  VIEW_CONTENT: 'Product viewed',
  ADD_TO_CART: 'Added to cart',
  INITIATE_CHECKOUT: 'COD form opened',
  ADD_PAYMENT_INFO: 'Payment details entered',
  PURCHASE: 'Order placed',
  LEAD: 'Lead captured',
  COMPLETE_REGISTRATION: 'Registration completed',
  SEARCH: 'Searched',
  CUSTOM: 'Custom event',
};

/**
 * Events this provider can actually receive.
 *
 * A custom endpoint is our own contract, so it takes anything; every other
 * provider is limited to the events it has a name for, and offering the rest
 * would let a merchant enable something that is silently dropped.
 */
export function eventsFor(provider: PixelProvider): readonly PixelEventName[] {
  if (provider === 'CUSTOM') {
    return Object.keys(EVENT_LABELS) as PixelEventName[];
  }

  return Object.keys(PROVIDER_EVENT_NAMES[provider]) as PixelEventName[];
}

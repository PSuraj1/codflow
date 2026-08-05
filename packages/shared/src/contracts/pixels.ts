import type { PixelEventName, PixelProvider } from '../enums.js';

/**
 * The pixel contract.
 *
 * Two things make server-side conversion tracking worth building rather than
 * leaving to a client-side script:
 *
 *  1. **COD orders complete outside the browser.** A shopper submits the form
 *    and closes the tab; the order is confirmed, pushed to Shopify and
 *    delivered days later. A browser pixel cannot observe any of that, so the
 *    Purchase event has to come from the server or it never fires at all.
 *  2. **Ad blockers and ITP.** A meaningful share of storefront traffic never
 *    executes a third-party pixel. Server-side events are not subject to that.
 *
 * The cost is deduplication: when both a browser event and a server event
 * describe the same action, the provider must be able to tell. That is what
 * `eventId` is for, and getting it wrong double-counts every conversion —
 * which silently corrupts the merchant's ad bidding.
 */

/** Where an event was sent from. Providers dedupe across the pair. */
export const PixelEventSource = {
  CLIENT: 'client',
  SERVER: 'server',
} as const;

export type PixelEventSource = (typeof PixelEventSource)[keyof typeof PixelEventSource];

/**
 * Provider-specific names for the standard events.
 *
 * Each provider has its own vocabulary for the same conversion, and sending the
 * wrong string means the event is recorded as a custom event that no campaign
 * optimises against — which looks like it is working, in the dashboard, while
 * doing nothing.
 */
export const PROVIDER_EVENT_NAMES: Readonly<
  Record<PixelProvider, Partial<Record<PixelEventName, string>>>
> = {
  META: {
    PAGE_VIEW: 'PageView',
    VIEW_CONTENT: 'ViewContent',
    ADD_TO_CART: 'AddToCart',
    INITIATE_CHECKOUT: 'InitiateCheckout',
    ADD_PAYMENT_INFO: 'AddPaymentInfo',
    PURCHASE: 'Purchase',
    LEAD: 'Lead',
    COMPLETE_REGISTRATION: 'CompleteRegistration',
    SEARCH: 'Search',
  },
  TIKTOK: {
    PAGE_VIEW: 'Pageview',
    VIEW_CONTENT: 'ViewContent',
    ADD_TO_CART: 'AddToCart',
    INITIATE_CHECKOUT: 'InitiateCheckout',
    ADD_PAYMENT_INFO: 'AddPaymentInfo',
    PURCHASE: 'CompletePayment',
    LEAD: 'SubmitForm',
    COMPLETE_REGISTRATION: 'CompleteRegistration',
    SEARCH: 'Search',
  },
  GOOGLE_ADS: {
    // Google Ads has one conversion action per configured label rather than a
    // named event vocabulary; the label carries the meaning.
    PURCHASE: 'conversion',
    LEAD: 'conversion',
  },
  SNAPCHAT: {
    PAGE_VIEW: 'PAGE_VIEW',
    VIEW_CONTENT: 'VIEW_CONTENT',
    ADD_TO_CART: 'ADD_CART',
    INITIATE_CHECKOUT: 'START_CHECKOUT',
    ADD_PAYMENT_INFO: 'ADD_BILLING',
    PURCHASE: 'PURCHASE',
    LEAD: 'SIGN_UP',
    SEARCH: 'SEARCH',
  },
  PINTEREST: {
    PAGE_VIEW: 'page_visit',
    VIEW_CONTENT: 'view_category',
    ADD_TO_CART: 'add_to_cart',
    INITIATE_CHECKOUT: 'checkout',
    PURCHASE: 'checkout',
    LEAD: 'lead',
    SEARCH: 'search',
  },
  CUSTOM: {},
} as const;

/**
 * Events that carry a monetary value.
 *
 * Sending a value on the others inflates a campaign's reported return — a
 * `ViewContent` worth ₹1,209 would make browsing look as profitable as buying.
 */
export const MONETARY_EVENTS: readonly PixelEventName[] = [
  'PURCHASE',
  'ADD_TO_CART',
  'INITIATE_CHECKOUT',
];

/**
 * Events CodFlow can raise server-side.
 *
 * Deliberately narrower than the full list: the server only observes what
 * happens to an *order*. Page views and searches are browser-only by nature,
 * and claiming to send them from the server would be a lie in the UI.
 */
export const SERVER_SIDE_EVENTS: readonly PixelEventName[] = [
  'INITIATE_CHECKOUT',
  'PURCHASE',
  'LEAD',
];

/** Which providers accept server-to-server events at all. */
export const SERVER_SIDE_PROVIDERS: readonly PixelProvider[] = [
  'META',
  'TIKTOK',
  'GOOGLE_ADS',
  'SNAPCHAT',
  'PINTEREST',
  'CUSTOM',
];

/** Merchant-facing pixel configuration. */
export interface PixelSummary {
  readonly id: string;
  readonly provider: PixelProvider;
  readonly label: string;
  readonly pixelId: string;
  readonly isEnabled: boolean;

  readonly clientSideEnabled: boolean;
  readonly serverSideEnabled: boolean;
  /** True when a Conversions API token is stored. The token itself never leaves the server. */
  readonly hasAccessToken: boolean;
  readonly testEventCode: string | null;
  readonly conversionLabel: string | null;
  readonly conversionId: string | null;
  readonly gtmContainerId: string | null;

  readonly advancedMatching: boolean;
  readonly deduplication: boolean;
  readonly requireConsent: boolean;

  readonly enabledEvents: readonly PixelEventName[];

  readonly lastEventAt: string | null;
  readonly totalSent: number;
  readonly totalFailed: number;
  readonly lastError: string | null;
}

/** One row of the event tester / recent activity log. */
export interface PixelEventSummary {
  readonly id: string;
  readonly pixelId: string | null;
  readonly provider: PixelProvider | null;
  readonly eventName: PixelEventName;
  readonly customEventName: string | null;
  readonly eventId: string;
  readonly status: string;
  readonly source: PixelEventSource;
  readonly responseCode: number | null;
  readonly errorMessage: string | null;
  readonly value: string | null;
  readonly currency: string | null;
  readonly createdAt: string;
}

/**
 * What the storefront needs in order to fire client-side events.
 *
 * Access tokens are absent by construction — this payload is public, and a
 * Conversions API token in it would let anyone write events into the merchant's
 * ad account.
 */
export interface StorefrontPixel {
  readonly provider: PixelProvider;
  readonly pixelId: string;
  readonly enabledEvents: readonly PixelEventName[];
  readonly advancedMatching: boolean;
  readonly requireConsent: boolean;
  /** Only for the CUSTOM provider, executed in the web pixel sandbox. */
  readonly customScript: string | null;
  readonly gtmContainerId: string | null;
  readonly conversionId: string | null;
  readonly conversionLabel: string | null;
}

/**
 * Result of a test event, for the diagnostics screen.
 *
 * `matchQuality` is only meaningful for Meta, which reports it; the others are
 * null rather than a fabricated number.
 */
export interface PixelTestResult {
  readonly provider: PixelProvider;
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly message: string;
  readonly eventId: string;
  readonly matchQuality: number | null;
  readonly sentAt: string;
}

/**
 * Fields used for advanced matching, in the order providers expect them.
 *
 * Every one is hashed before it leaves the server. The point of listing them
 * here is that the *normalization* is provider-agnostic — lowercase, trim,
 * strip punctuation — and getting it wrong produces a valid-looking hash that
 * matches nobody, which is indistinguishable from having no matching at all.
 */
export const ADVANCED_MATCHING_FIELDS = [
  'email',
  'phone',
  'firstName',
  'lastName',
  'city',
  'state',
  'zip',
  'country',
] as const;

export type AdvancedMatchingField = (typeof ADVANCED_MATCHING_FIELDS)[number];

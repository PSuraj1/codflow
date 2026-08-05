import { Locale, Plan } from './enums.js';

/**
 * Cross-cutting constants. Anything here is referenced by at least two of
 * {API, admin UI, extensions} — single-app values belong in that app.
 */

/**
 * Shopify Admin API version. Pinned deliberately: Shopify has no `latest` alias
 * for the API endpoint and explicitly recommends hardcoding a dated version.
 * Requesting a retired version silently "falls forward" to the oldest supported
 * one, which would break queries in ways that are hard to trace.
 *
 * Bump quarterly and re-run the GraphQL queries against the new version first.
 * Note that `@shopify/shopify-api` v13 removed the `LATEST_API_VERSION` export,
 * so the API instance must reference `ApiVersion.July26` explicitly.
 */
export const SHOPIFY_API_VERSION = '2026-07' as const;

/** Locale -> BCP 47 tag, for Intl formatting and the `lang` attribute. */
export const LOCALE_TAGS: Record<Locale, string> = {
  [Locale.EN]: 'en',
  [Locale.HI]: 'hi',
  [Locale.AR]: 'ar',
  [Locale.FR]: 'fr',
  [Locale.ES]: 'es',
  [Locale.DE]: 'de',
};

/** Locales that render right-to-left. Drives the `dir` attribute and Polaris layout. */
export const RTL_LOCALES: readonly Locale[] = [Locale.AR];

export const LOCALE_LABELS: Record<Locale, string> = {
  [Locale.EN]: 'English',
  [Locale.HI]: 'हिन्दी',
  [Locale.AR]: 'العربية',
  [Locale.FR]: 'Français',
  [Locale.ES]: 'Español',
  [Locale.DE]: 'Deutsch',
};

/**
 * Monthly plan limits enforced against UsageRecord. `null` means unmetered.
 *
 * These mirror the plans configured in Shopify App Pricing in the Partner
 * Dashboard — Shopify owns pricing and charging, this app owns enforcement.
 * If you change a tier here, change it there too.
 */
export interface PlanLimits {
  readonly codOrders: number | null;
  readonly sheetSyncs: number | null;
  readonly otpSends: number | null;
  readonly pixelEvents: number | null;
  readonly pixels: number | null;
  readonly forms: number | null;
  readonly automations: number | null;
  readonly sheetConfigs: number | null;
  readonly serverSideTracking: boolean;
  readonly fraudEngine: boolean;
  readonly otpVerification: boolean;
  readonly customCss: boolean;
  readonly prioritySupport: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  [Plan.FREE]: {
    codOrders: 50,
    sheetSyncs: 50,
    otpSends: 0,
    pixelEvents: 1_000,
    pixels: 1,
    forms: 1,
    automations: 1,
    sheetConfigs: 1,
    serverSideTracking: false,
    fraudEngine: false,
    otpVerification: false,
    customCss: false,
    prioritySupport: false,
  },
  [Plan.STARTER]: {
    codOrders: 500,
    sheetSyncs: 1_000,
    otpSends: 500,
    pixelEvents: 25_000,
    pixels: 3,
    forms: 3,
    automations: 5,
    sheetConfigs: 2,
    serverSideTracking: true,
    fraudEngine: true,
    otpVerification: true,
    customCss: false,
    prioritySupport: false,
  },
  [Plan.PRO]: {
    codOrders: 5_000,
    sheetSyncs: 20_000,
    otpSends: 5_000,
    pixelEvents: 250_000,
    pixels: 10,
    forms: 10,
    automations: 25,
    sheetConfigs: 10,
    serverSideTracking: true,
    fraudEngine: true,
    otpVerification: true,
    customCss: true,
    prioritySupport: false,
  },
  [Plan.ENTERPRISE]: {
    codOrders: null,
    sheetSyncs: null,
    otpSends: null,
    pixelEvents: null,
    pixels: null,
    forms: null,
    automations: null,
    sheetConfigs: null,
    serverSideTracking: true,
    fraudEngine: true,
    otpVerification: true,
    customCss: true,
    prioritySupport: true,
  },
};

/** Usage metric keys. Must match `UsageRecord.metric` values written by the API. */
export const USAGE_METRICS = {
  COD_ORDERS: 'cod_orders',
  SHEET_SYNCS: 'sheet_syncs',
  OTP_SENDS: 'otp_sends',
  PIXEL_EVENTS: 'pixel_events',
} as const;
export type UsageMetric = (typeof USAGE_METRICS)[keyof typeof USAGE_METRICS];

/** Risk score bounds. The engine clamps to this range before persisting. */
export const RISK_SCORE_MIN = 0;
export const RISK_SCORE_MAX = 100;

/**
 * Form field keys the merchant may relabel and reorder but never delete —
 * the order pipeline reads them by key. Mirrors `FormField.isSystem`.
 */
export const SYSTEM_FORM_FIELD_KEYS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'address1',
  'city',
  'province',
  'country',
  'postalCode',
] as const;
export type SystemFormFieldKey = (typeof SYSTEM_FORM_FIELD_KEYS)[number];

/** The one field a COD order cannot be created without. */
export const REQUIRED_FORM_FIELD_KEY = 'phone' as const;

/** Pagination defaults applied by the API when the client omits them. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 250;

/** Prefix for the human-facing `CodOrder.reference`, e.g. `CF-K3M9XQ2A`. */
export const ORDER_REFERENCE_PREFIX = 'CF' as const;

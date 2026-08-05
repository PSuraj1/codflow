import type { Locale, Plan, SubscriptionStatus, ThemeMode } from '../enums.js';

/**
 * Contracts for the authentication surface.
 *
 * The admin SPA calls `GET /api/admin/session` immediately after App Bridge
 * boots. That single round trip both proves the session token exchange worked
 * and returns everything the shell needs to render — shop identity, plan,
 * onboarding state — so the app does not open with a cascade of requests.
 */

export interface ShopIdentity {
  readonly id: string;
  readonly domain: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly countryCode: string | null;
  readonly currencyCode: string;
  readonly primaryLocale: string;
  readonly ianaTimezone: string | null;
  readonly shopifyPlan: string | null;
  readonly installedAt: string;
  readonly isActive: boolean;
}

export interface SubscriptionSummary {
  readonly plan: Plan;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: string | null;
  readonly currentPeriodEnd: string | null;
  readonly isTest: boolean;
}

export interface OnboardingState {
  readonly completed: boolean;
  readonly step: number;
}

/**
 * Scope reconciliation.
 *
 * `granted` is what the merchant actually consented to at install; `required`
 * is what shopify.app.toml declares today. They diverge whenever scopes are
 * added and the app is deployed but the merchant has not re-consented yet.
 * The admin surfaces `missing` as a banner rather than failing every request,
 * because most screens still work without the new scope.
 */
export interface ScopeState {
  readonly granted: readonly string[];
  readonly required: readonly string[];
  readonly missing: readonly string[];
  readonly satisfied: boolean;
}

export interface UiPreferences {
  readonly defaultLocale: Locale;
  readonly enabledLocales: readonly Locale[];
  readonly themeMode: ThemeMode;
  readonly brandPrimaryColor: string;
}

/** Response body of `GET /api/admin/session`. */
export interface SessionResponse {
  readonly shop: ShopIdentity;
  readonly subscription: SubscriptionSummary;
  readonly onboarding: OnboardingState;
  readonly scopes: ScopeState;
  readonly preferences: UiPreferences;
  /**
   * Staff member the session token was issued for. Null for offline-only
   * contexts. Used for audit attribution, never for authorization — Shopify
   * has already decided the merchant may open this app.
   */
  readonly user: {
    readonly id: string;
    readonly locale: string | null;
  } | null;
  /** Echoes the pinned Admin API version so the UI can show it in diagnostics. */
  readonly apiVersion: string;
}

/** Response body of `GET /api/health` and `/api/health/ready`. */
export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly uptimeSeconds: number;
  readonly version: string;
  readonly checks?: Readonly<Record<string, boolean>>;
}

/**
 * The analytics contract.
 *
 * Every number here is read from `DailyStat` — one pre-aggregated row per shop
 * per day — rather than computed from `cod_orders` at request time. The reason
 * is the shape of the query a dashboard makes: "revenue per day for the last 90
 * days" over raw orders is a scan and a group-by that gets slower every month
 * the merchant uses the app, and it runs on the screen they open first. Against
 * `DailyStat` it is ninety indexed rows, and stays ninety forever.
 *
 * The cost of that choice is that the aggregate has to be *written*, from two
 * places that can disagree: CODkar's own lifecycle (an order was created,
 * pushed, blocked) and Shopify's webhooks (it was cancelled, fulfilled,
 * refunded). Both write through the same recorder, and the whole range can be
 * rebuilt from `cod_orders` when they do drift — see `POST /rebuild`.
 *
 * A note on money: every amount crosses the wire as a decimal *string*. These
 * are Postgres `DECIMAL(14,2)` values, and `JSON.parse` would silently round
 * them through a float. The admin formats them with `Intl.NumberFormat`; it
 * never does arithmetic on them.
 */

/** Named ranges the dashboard offers. `custom` carries explicit dates. */
export const AnalyticsRange = {
  TODAY: 'today',
  LAST_7: '7d',
  LAST_30: '30d',
  LAST_90: '90d',
  MONTH_TO_DATE: 'mtd',
  CUSTOM: 'custom',
} as const;

export type AnalyticsRange = (typeof AnalyticsRange)[keyof typeof AnalyticsRange];

/**
 * The window a response covers.
 *
 * Dates are `YYYY-MM-DD` in the *shop's* timezone, not the viewer's and not
 * UTC. A merchant in Delhi closing their day at 23:59 IST expects that order in
 * today's total; bucketing by UTC would push it into tomorrow, and the day they
 * are looking at would disagree with the day Shopify shows them.
 */
export interface AnalyticsPeriod {
  readonly from: string;
  readonly to: string;
  readonly days: number;
  /** IANA zone the buckets were cut on, e.g. `Asia/Kolkata`. */
  readonly timezone: string;
}

/** Which way a change points, and whether that is good news. */
export const TrendDirection = {
  UP: 'up',
  DOWN: 'down',
  FLAT: 'flat',
} as const;

export type TrendDirection = (typeof TrendDirection)[keyof typeof TrendDirection];

/**
 * One headline number with its comparison.
 *
 * `changePct` is null rather than 0 or Infinity when the previous period was
 * zero. "Up 100%" from a base of nothing is not information, and rendering ∞ in
 * a stat tile is how a dashboard loses a merchant's trust in every other number
 * on it.
 */
export interface MetricPoint {
  readonly value: number;
  readonly previous: number;
  readonly changePct: number | null;
  readonly direction: TrendDirection;
}

/** Money equivalent of `MetricPoint`. Amounts are decimal strings. */
export interface MoneyPoint {
  readonly value: string;
  readonly previous: string;
  readonly changePct: number | null;
  readonly direction: TrendDirection;
  readonly currency: string;
}

/** One day of the series. Every metric for the day, so the client can switch
 * which one it plots without another round trip. */
export interface AnalyticsDayPoint {
  readonly date: string;

  readonly formViews: number;
  readonly formStarts: number;
  readonly formSubmissions: number;
  readonly buttonClicks: number;

  readonly codOrders: number;
  readonly confirmedOrders: number;
  readonly pushedOrders: number;
  readonly cancelledOrders: number;
  readonly returnedOrders: number;
  readonly fulfilledOrders: number;
  readonly abandonedOrders: number;

  readonly revenue: string;
  readonly cancelledValue: string;
  readonly returnedValue: string;
  readonly averageOrderValue: string;

  readonly blockedAttempts: number;
  readonly highRiskOrders: number;

  readonly otpSent: number;
  readonly otpVerified: number;
  readonly otpFailed: number;

  readonly sheetSyncSuccess: number;
  readonly sheetSyncFailed: number;
  readonly pixelEventsSent: number;
  readonly pixelEventsFailed: number;
}

/** Metrics the time-series chart can plot. One axis, one metric at a time. */
export const SeriesMetric = {
  ORDERS: 'orders',
  REVENUE: 'revenue',
  CONVERSION: 'conversion',
  CANCELLED: 'cancelled',
  RETURNED: 'returned',
  HIGH_RISK: 'highRisk',
  BLOCKED: 'blocked',
} as const;

export type SeriesMetric = (typeof SeriesMetric)[keyof typeof SeriesMetric];

/** `GET /api/admin/analytics/overview`. */
export interface AnalyticsOverview {
  readonly period: AnalyticsPeriod;
  /** The equally-long window immediately before `period`, for the deltas. */
  readonly comparedTo: AnalyticsPeriod;
  readonly currency: string;

  readonly orders: MetricPoint;
  readonly revenue: MoneyPoint;
  readonly averageOrderValue: MoneyPoint;

  /**
   * Submissions per form view, as a percentage.
   *
   * Only meaningful once the storefront reports views — a shop with orders and
   * no view telemetry would otherwise read as an impossible conversion rate.
   * `null` says "not measurable", which is different from zero.
   */
  readonly conversionRate: MetricPoint | null;
  readonly confirmationRate: MetricPoint | null;
  readonly cancellationRate: MetricPoint | null;
  readonly returnRate: MetricPoint | null;

  readonly highRiskOrders: MetricPoint;
  readonly blockedAttempts: MetricPoint;

  /** Live counters for the shop's current day, outside the range comparison. */
  readonly today: {
    readonly orders: number;
    readonly revenue: string;
    readonly pendingPush: number;
    readonly awaitingReview: number;
  };

  readonly series: readonly AnalyticsDayPoint[];
}

/** One row of a dimensional breakdown. */
export interface BreakdownRow {
  readonly key: string;
  readonly label: string;
  readonly orders: number;
  readonly revenue: string;
  /** Share of the period's orders, 0–100. */
  readonly share: number;
}

export const BreakdownDimension = {
  COUNTRY: 'country',
  CITY: 'city',
  PRODUCT: 'product',
} as const;

export type BreakdownDimension =
  (typeof BreakdownDimension)[keyof typeof BreakdownDimension];

/**
 * `GET /api/admin/analytics/breakdown`.
 *
 * The tail is folded into one `other` row rather than returned in full: past
 * about eight bars a ranking stops being readable, and the long tail of a
 * country list is a hundred rows of one order each.
 */
export interface AnalyticsBreakdown {
  readonly dimension: BreakdownDimension;
  readonly period: AnalyticsPeriod;
  readonly currency: string;
  readonly rows: readonly BreakdownRow[];
  readonly other: BreakdownRow | null;
  readonly totalOrders: number;
}

/**
 * One step of the COD funnel.
 *
 * `conversionFromPrevious` is the drop-off that actually diagnoses a problem —
 * a shop losing 80% between "form opened" and "submitted" has a form problem,
 * while one losing 80% between "submitted" and "pushed" has a fraud rule or a
 * Shopify problem. Those need different fixes, and a single conversion number
 * cannot tell them apart.
 */
export interface FunnelStage {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  /** Percentage of the first stage, 0–100. */
  readonly conversionFromStart: number;
  /** Percentage of the preceding stage, 0–100. Null on the first stage. */
  readonly conversionFromPrevious: number | null;
}

export interface AnalyticsFunnel {
  readonly period: AnalyticsPeriod;
  readonly stages: readonly FunnelStage[];
  /** True when the storefront has not reported view telemetry for the period. */
  readonly viewsMissing: boolean;
}

/** Traffic-light state for one subsystem on the store-health card. */
export const HealthState = {
  OK: 'ok',
  WARNING: 'warning',
  CRITICAL: 'critical',
  NOT_CONFIGURED: 'not_configured',
} as const;

export type HealthState = (typeof HealthState)[keyof typeof HealthState];

export interface HealthCheck {
  readonly key: string;
  readonly label: string;
  readonly state: HealthState;
  readonly summary: string;
  /** Admin path the merchant should open to act on it, when there is one. */
  readonly actionPath: string | null;
}

/**
 * `GET /api/admin/analytics/health`.
 *
 * The point of this card is that the failures it reports are silent ones. A
 * Google token that expired, a pixel rejecting every event, orders stuck before
 * Shopify — none of them produce an error the merchant sees, and all of them
 * cost money for as long as they go unnoticed.
 */
export interface StoreHealth {
  readonly overall: HealthState;
  readonly checks: readonly HealthCheck[];
  readonly generatedAt: string;
}

/** `POST /api/admin/analytics/rebuild`. */
export interface RebuildStatsResult {
  readonly queued: boolean;
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

/**
 * Storefront telemetry the theme extension reports.
 *
 * Deliberately tiny and deliberately unauthenticated — it is called from a
 * shopper's browser. It carries no identifiers, only which counter to increment,
 * so the worst a forged call can do is inflate a merchant's own funnel numbers.
 * Nothing on the money side of the dashboard is reachable from here.
 */
export const TelemetryEvent = {
  FORM_VIEW: 'form_view',
  FORM_START: 'form_start',
  BUTTON_CLICK: 'button_click',
} as const;

export type TelemetryEvent = (typeof TelemetryEvent)[keyof typeof TelemetryEvent];

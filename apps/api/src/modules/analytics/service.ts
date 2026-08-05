import { Prisma, type DailyStat } from '@prisma/client';
import {
  AnalyticsRange,
  BreakdownDimension,
  HealthState,
  TrendDirection,
  type AnalyticsBreakdown,
  type AnalyticsDayPoint,
  type AnalyticsFunnel,
  type AnalyticsOverview,
  type AnalyticsPeriod,
  type BreakdownRow,
  type FunnelStage,
  type HealthCheck,
  type MetricPoint,
  type MoneyPoint,
  type StoreHealth,
} from '@codflow/shared';
import { prisma } from '../../db/prisma';
import { NotFoundError, ValidationError } from '../../lib/errors';
import {
  addDays,
  daysBetween,
  eachDay,
  fromDateColumn,
  resolveTimezone,
  shopToday,
  startOfMonth,
  type IsoDate,
} from '../../lib/shopTime';
import * as shopRepository from '../shop/repository';
import * as repository from './repository';

/**
 * Analytics read model.
 *
 * Everything here is arithmetic over `DailyStat` rows. The rules that are easy
 * to get subtly wrong, and are therefore centralised:
 *
 *  - **Rates are computed from period totals, never averaged across days.** The
 *    mean of daily conversion rates is not the period's conversion rate — a day
 *    with two views and one order would count as heavily as a day with two
 *    thousand. Sum the numerators, sum the denominators, divide once.
 *  - **A missing day is a zero, not a gap.** The chart must show the day the
 *    merchant had no orders; leaving it out silently rescales the x-axis and
 *    hides exactly the problem they opened the dashboard to find.
 *  - **An impossible ratio is null, not zero.** No views means the conversion
 *    rate is unknown. Rendering 0% would tell the merchant their form converts
 *    nobody, which is a different and much more alarming claim.
 */

const MAX_RANGE_DAYS = 366;

/** The period a request asks for, resolved against the shop's own calendar. */
export interface ResolvedRange {
  readonly period: AnalyticsPeriod;
  readonly comparedTo: AnalyticsPeriod;
  readonly timezone: string;
  readonly currency: string;
  readonly today: IsoDate;
}

function period(from: IsoDate, to: IsoDate, timezone: string): AnalyticsPeriod {
  return { from, to, days: daysBetween(from, to), timezone };
}

/**
 * Turns a range key into two concrete windows.
 *
 * The comparison window is the same length immediately before the period, so a
 * 30-day view compares against the 30 days before it. Comparing against "the
 * same period last month" would be more familiar from finance tooling and
 * wrong here: months differ in length, and a merchant reading a 7-day view
 * wants last week.
 */
export async function resolveRange(
  shopId: string,
  input: { range: AnalyticsRange; from?: string; to?: string },
): Promise<ResolvedRange> {
  const shop = await shopRepository.findAnalyticsContext(shopId);
  if (!shop) throw new NotFoundError('Shop not found');

  const timezone = resolveTimezone(shop.ianaTimezone ?? shop.timezone);
  const today = shopToday(timezone);

  let from: IsoDate;
  let to: IsoDate = today;

  switch (input.range) {
    case AnalyticsRange.TODAY:
      from = today;
      break;
    case AnalyticsRange.LAST_7:
      from = addDays(today, -6);
      break;
    case AnalyticsRange.LAST_30:
      from = addDays(today, -29);
      break;
    case AnalyticsRange.LAST_90:
      from = addDays(today, -89);
      break;
    case AnalyticsRange.MONTH_TO_DATE:
      from = startOfMonth(today);
      break;
    case AnalyticsRange.CUSTOM: {
      if (!input.from || !input.to) {
        throw new ValidationError('A custom range needs both a start and an end date');
      }

      from = input.from;
      to = input.to;

      if (daysBetween(from, to) <= 0) {
        throw new ValidationError('The start date must not be after the end date');
      }

      if (daysBetween(from, to) > MAX_RANGE_DAYS) {
        // Not a performance limit — the query is indexed and would survive it.
        // It is a readability limit: a chart with two thousand points is a
        // smear, and the merchant is better served by a coarser grain.
        throw new ValidationError(`A range cannot be longer than ${MAX_RANGE_DAYS} days`);
      }

      break;
    }
    default:
      from = addDays(today, -29);
  }

  const length = daysBetween(from, to);
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, -(length - 1));

  return {
    period: period(from, to, timezone),
    comparedTo: period(previousFrom, previousTo, timezone),
    timezone,
    currency: shop.currencyCode,
    today,
  };
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

function direction(value: number, previous: number): TrendDirection {
  if (value > previous) return TrendDirection.UP;
  if (value < previous) return TrendDirection.DOWN;
  return TrendDirection.FLAT;
}

/**
 * Percentage change, or null when there is no base to change from.
 *
 * "Up 100%" from zero is not information — every first order would report it —
 * and `Infinity` serialises to `null` in JSON anyway, so returning it
 * deliberately is the only way the client can tell the two apart.
 */
function changePct(value: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((value - previous) / previous) * 1_000) / 10;
}

function metric(value: number, previous: number): MetricPoint {
  return { value, previous, changePct: changePct(value, previous), direction: direction(value, previous) };
}

function money(value: Prisma.Decimal, previous: Prisma.Decimal, currency: string): MoneyPoint {
  const current = Number(value);
  const before = Number(previous);

  return {
    value: value.toFixed(2),
    previous: previous.toFixed(2),
    changePct: changePct(current, before),
    direction: direction(current, before),
    currency,
  };
}

/**
 * A rate as a percentage, or null when the denominator is zero.
 *
 * `previousRate` is passed separately rather than derived, because a rate's
 * comparison has to be computed the same way — from the previous period's own
 * totals, not from the previous period's stored average.
 */
function rate(
  numerator: number,
  denominator: number,
  previousNumerator: number,
  previousDenominator: number,
): MetricPoint | null {
  if (denominator === 0) return null;

  const value = Math.round((numerator / denominator) * 1_000) / 10;
  const previous =
    previousDenominator === 0 ? 0 : Math.round((previousNumerator / previousDenominator) * 1_000) / 10;

  return {
    value,
    previous,
    changePct: previousDenominator === 0 ? null : changePct(value, previous),
    direction: previousDenominator === 0 ? TrendDirection.FLAT : direction(value, previous),
  };
}

interface Totals {
  formViews: number;
  formStarts: number;
  formSubmissions: number;
  buttonClicks: number;
  codOrders: number;
  confirmedOrders: number;
  pushedOrders: number;
  cancelledOrders: number;
  returnedOrders: number;
  fulfilledOrders: number;
  abandonedOrders: number;
  highRiskOrders: number;
  blockedAttempts: number;
  revenue: Prisma.Decimal;
  cancelledValue: Prisma.Decimal;
  returnedValue: Prisma.Decimal;
}

function emptyTotals(): Totals {
  return {
    formViews: 0,
    formStarts: 0,
    formSubmissions: 0,
    buttonClicks: 0,
    codOrders: 0,
    confirmedOrders: 0,
    pushedOrders: 0,
    cancelledOrders: 0,
    returnedOrders: 0,
    fulfilledOrders: 0,
    abandonedOrders: 0,
    highRiskOrders: 0,
    blockedAttempts: 0,
    revenue: new Prisma.Decimal(0),
    cancelledValue: new Prisma.Decimal(0),
    returnedValue: new Prisma.Decimal(0),
  };
}

function sum(rows: readonly DailyStat[]): Totals {
  const totals = emptyTotals();

  for (const row of rows) {
    totals.formViews += row.formViews;
    totals.formStarts += row.formStarts;
    totals.formSubmissions += row.formSubmissions;
    totals.buttonClicks += row.buttonClicks;
    totals.codOrders += row.codOrders;
    totals.confirmedOrders += row.confirmedOrders;
    totals.pushedOrders += row.pushedOrders;
    totals.cancelledOrders += row.cancelledOrders;
    totals.returnedOrders += row.returnedOrders;
    totals.fulfilledOrders += row.fulfilledOrders;
    totals.abandonedOrders += row.abandonedOrders;
    totals.highRiskOrders += row.highRiskOrders;
    totals.blockedAttempts += row.blockedAttempts;
    totals.revenue = totals.revenue.add(row.revenue);
    totals.cancelledValue = totals.cancelledValue.add(row.cancelledValue);
    totals.returnedValue = totals.returnedValue.add(row.returnedValue);
  }

  return totals;
}

/** Zero-fills a range so every day between the ends is a point on the chart. */
function densify(rows: readonly DailyStat[], from: IsoDate, to: IsoDate): AnalyticsDayPoint[] {
  const byDate = new Map(rows.map((row) => [fromDateColumn(row.date), row]));

  return eachDay(from, to).map((date) => {
    const row = byDate.get(date);

    if (!row) {
      return {
        date,
        formViews: 0,
        formStarts: 0,
        formSubmissions: 0,
        buttonClicks: 0,
        codOrders: 0,
        confirmedOrders: 0,
        pushedOrders: 0,
        cancelledOrders: 0,
        returnedOrders: 0,
        fulfilledOrders: 0,
        abandonedOrders: 0,
        revenue: '0.00',
        cancelledValue: '0.00',
        returnedValue: '0.00',
        averageOrderValue: '0.00',
        blockedAttempts: 0,
        highRiskOrders: 0,
        otpSent: 0,
        otpVerified: 0,
        otpFailed: 0,
        sheetSyncSuccess: 0,
        sheetSyncFailed: 0,
        pixelEventsSent: 0,
        pixelEventsFailed: 0,
      };
    }

    return {
      date,
      formViews: row.formViews,
      formStarts: row.formStarts,
      formSubmissions: row.formSubmissions,
      buttonClicks: row.buttonClicks,
      codOrders: row.codOrders,
      confirmedOrders: row.confirmedOrders,
      pushedOrders: row.pushedOrders,
      cancelledOrders: row.cancelledOrders,
      returnedOrders: row.returnedOrders,
      fulfilledOrders: row.fulfilledOrders,
      abandonedOrders: row.abandonedOrders,
      revenue: row.revenue.toFixed(2),
      cancelledValue: row.cancelledValue.toFixed(2),
      returnedValue: row.returnedValue.toFixed(2),
      averageOrderValue: row.averageOrderValue.toFixed(2),
      blockedAttempts: row.blockedAttempts,
      highRiskOrders: row.highRiskOrders,
      otpSent: row.otpSent,
      otpVerified: row.otpVerified,
      otpFailed: row.otpFailed,
      sheetSyncSuccess: row.sheetSyncSuccess,
      sheetSyncFailed: row.sheetSyncFailed,
      pixelEventsSent: row.pixelEventsSent,
      pixelEventsFailed: row.pixelEventsFailed,
    };
  });
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(shopId: string, range: ResolvedRange): Promise<AnalyticsOverview> {
  const [current, previous, live, todayRow] = await Promise.all([
    repository.findRange(shopId, range.period.from, range.period.to),
    repository.findRange(shopId, range.comparedTo.from, range.comparedTo.to),
    repository.liveCounters(shopId),
    repository.findDay(shopId, range.today),
  ]);

  const now = sum(current);
  const before = sum(previous);

  /**
   * The average order value of a *period* is its revenue over its order count —
   * not the average of the daily averages, which would weight a one-order day
   * as heavily as a hundred-order day.
   */
  const averageOf = (totals: Totals): Prisma.Decimal =>
    totals.codOrders > 0 ? totals.revenue.dividedBy(totals.codOrders).toDecimalPlaces(2) : new Prisma.Decimal(0);

  return {
    period: range.period,
    comparedTo: range.comparedTo,
    currency: range.currency,

    orders: metric(now.codOrders, before.codOrders),
    revenue: money(now.revenue, before.revenue, range.currency),
    averageOrderValue: money(averageOf(now), averageOf(before), range.currency),

    conversionRate: rate(now.formSubmissions, now.formViews, before.formSubmissions, before.formViews),
    confirmationRate: rate(now.confirmedOrders, now.codOrders, before.confirmedOrders, before.codOrders),
    cancellationRate: rate(now.cancelledOrders, now.codOrders, before.cancelledOrders, before.codOrders),
    returnRate: rate(now.returnedOrders, now.codOrders, before.returnedOrders, before.codOrders),

    highRiskOrders: metric(now.highRiskOrders, before.highRiskOrders),
    blockedAttempts: metric(now.blockedAttempts, before.blockedAttempts),

    today: {
      orders: todayRow?.codOrders ?? 0,
      revenue: (todayRow?.revenue ?? new Prisma.Decimal(0)).toFixed(2),
      pendingPush: live.pendingPush,
      awaitingReview: live.awaitingReview,
    },

    series: densify(current, range.period.from, range.period.to),
  };
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

const MAX_BREAKDOWN_ROWS = 8;

/** A country code rendered for a merchant, with the code kept as the key. */
function countryLabel(code: string): string {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return names.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

interface Accumulated {
  orders: number;
  revenue: number;
  label: string;
}

/**
 * Aggregates one JSON map across a range.
 *
 * The tail past `MAX_BREAKDOWN_ROWS` is folded into a single "Other" row rather
 * than returned. Past roughly eight bars a ranking stops being readable, and
 * the tail of a country list is a hundred rows of one order each — which pushes
 * the rows that matter off the screen.
 */
export async function breakdown(
  shopId: string,
  range: ResolvedRange,
  dimension: BreakdownDimension,
): Promise<AnalyticsBreakdown> {
  const rows = await repository.findRange(shopId, range.period.from, range.period.to);
  const accumulated = new Map<string, Accumulated>();

  for (const row of rows) {
    if (dimension === BreakdownDimension.PRODUCT) {
      const products = row.ordersByProduct as Record<
        string,
        { title?: string; orders?: number; revenue?: number }
      > | null;

      for (const [gid, entry] of Object.entries(products ?? {})) {
        const existing = accumulated.get(gid) ?? { orders: 0, revenue: 0, label: entry.title ?? gid };
        accumulated.set(gid, {
          label: entry.title ?? existing.label,
          orders: existing.orders + (entry.orders ?? 0),
          revenue: existing.revenue + (entry.revenue ?? 0),
        });
      }

      continue;
    }

    const source = (dimension === BreakdownDimension.COUNTRY ? row.ordersByCountry : row.ordersByCity) as
      | Record<string, number>
      | null;

    // A city map has no revenue of its own — the aggregate stores counts only —
    // so revenue is apportioned by the day's average order value. Stating it
    // exactly would mean a second map per dimension, doubling the row's size
    // for a number the merchant reads as an order of magnitude.
    const perOrder = row.codOrders > 0 ? Number(row.revenue) / row.codOrders : 0;

    for (const [key, count] of Object.entries(source ?? {})) {
      if (typeof count !== 'number') continue;

      const label = dimension === BreakdownDimension.COUNTRY ? countryLabel(key) : key;
      const existing = accumulated.get(key) ?? { orders: 0, revenue: 0, label };

      accumulated.set(key, {
        label,
        orders: existing.orders + count,
        revenue: existing.revenue + count * perOrder,
      });
    }
  }

  const ranked = [...accumulated.entries()].sort((left, right) => right[1].orders - left[1].orders);
  const totalOrders = ranked.reduce((total, [, entry]) => total + entry.orders, 0);

  const toRow = ([key, entry]: [string, Accumulated]): BreakdownRow => ({
    key,
    label: entry.label,
    orders: entry.orders,
    revenue: entry.revenue.toFixed(2),
    share: totalOrders > 0 ? Math.round((entry.orders / totalOrders) * 1_000) / 10 : 0,
  });

  const head = ranked.slice(0, MAX_BREAKDOWN_ROWS).map(toRow);
  const tail = ranked.slice(MAX_BREAKDOWN_ROWS);

  const other: BreakdownRow | null =
    tail.length === 0
      ? null
      : {
          key: '__other__',
          label: `Other (${tail.length})`,
          orders: tail.reduce((total, [, entry]) => total + entry.orders, 0),
          revenue: tail.reduce((total, [, entry]) => total + entry.revenue, 0).toFixed(2),
          share:
            totalOrders > 0
              ? Math.round((tail.reduce((total, [, entry]) => total + entry.orders, 0) / totalOrders) * 1_000) /
                10
              : 0,
        };

  return {
    dimension,
    period: range.period,
    currency: range.currency,
    rows: head,
    other,
    totalOrders,
  };
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

/**
 * The COD funnel, from a shopper seeing the button to a delivered order.
 *
 * Ordered by what a merchant can act on. A collapse between "viewed" and
 * "opened" is a button problem; between "opened" and "submitted" is a form
 * problem; between "submitted" and "in Shopify" is a fraud rule or a push
 * failure. One overall conversion number cannot distinguish them, which is why
 * this exists as its own endpoint rather than a percentage on a tile.
 */
export async function funnel(shopId: string, range: ResolvedRange): Promise<AnalyticsFunnel> {
  const rows = await repository.findRange(shopId, range.period.from, range.period.to);
  const totals = sum(rows);

  const stages: Array<{ key: string; label: string; count: number }> = [
    { key: 'views', label: 'Saw the COD button', count: totals.formViews },
    { key: 'starts', label: 'Opened the form', count: totals.formStarts },
    { key: 'submissions', label: 'Submitted an order', count: totals.codOrders },
    { key: 'accepted', label: 'Passed fraud checks', count: totals.confirmedOrders },
    { key: 'pushed', label: 'Created in Shopify', count: totals.pushedOrders },
  ];

  // Without view telemetry the first two stages are unknown rather than zero.
  // Showing them as zero would draw a funnel that starts below its own second
  // stage, which reads as a data error and undermines the stages that are real.
  const viewsMissing = totals.formViews === 0;
  const visible = viewsMissing ? stages.slice(2) : stages;
  const first = visible[0]?.count ?? 0;

  const resolved: FunnelStage[] = visible.map((stage, index) => {
    const previous = index === 0 ? null : visible[index - 1]?.count ?? 0;

    return {
      key: stage.key,
      label: stage.label,
      count: stage.count,
      conversionFromStart: first > 0 ? Math.round((stage.count / first) * 1_000) / 10 : 0,
      conversionFromPrevious:
        previous === null || previous === 0 ? null : Math.round((stage.count / previous) * 1_000) / 10,
    };
  });

  return { period: range.period, stages: resolved, viewsMissing };
}

// ---------------------------------------------------------------------------
// Store health
// ---------------------------------------------------------------------------

const WORST_FIRST: readonly HealthState[] = [
  HealthState.CRITICAL,
  HealthState.WARNING,
  HealthState.OK,
  HealthState.NOT_CONFIGURED,
];

/**
 * The state of every subsystem that can fail silently.
 *
 * This card exists because none of these failures produce anything the merchant
 * sees. A Google refresh token revoked three weeks ago, a pixel rejecting every
 * event, orders piling up behind a push failure — the app keeps looking fine
 * from the outside, and each costs money for as long as it goes unnoticed.
 */
export async function health(shopId: string): Promise<StoreHealth> {
  const [sheetConfig, googleAccount, pixels, stuckOrders, failedPixelEvents, settings] =
    await Promise.all([
      prisma.sheetConfig.findFirst({
        where: { shopId, isActive: true },
        select: { lastSyncStatus: true, lastError: true, lastSyncedAt: true, totalFailed: true },
      }),
      prisma.googleAccount.findFirst({
        where: { shopId },
        select: { isActive: true, revokedAt: true, email: true, lastError: true },
      }),
      prisma.pixel.findMany({
        where: { shopId, isEnabled: true },
        select: { label: true, provider: true, lastError: true, totalFailed: true, totalSent: true },
      }),
      prisma.codOrder.count({
        where: {
          shopId,
          status: 'FAILED',
          shopifyOrderGid: null,
        },
      }),
      prisma.pixelEvent.count({
        where: {
          shopId,
          status: 'FAILED',
          createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
        },
      }),
      prisma.shopSettings.findUnique({
        where: { shopId },
        select: { codEnabled: true },
      }),
    ]);

  const checks: HealthCheck[] = [];

  // ---- COD itself
  checks.push({
    key: 'cod',
    label: 'Cash on delivery',
    state: settings?.codEnabled ? HealthState.OK : HealthState.WARNING,
    summary: settings?.codEnabled
      ? 'COD is live on your storefront.'
      : 'COD is switched off — shoppers see your normal checkout.',
    actionPath: settings?.codEnabled ? null : '/settings/visibility',
  });

  // ---- Orders reaching Shopify
  checks.push({
    key: 'push',
    label: 'Orders in Shopify',
    state: stuckOrders === 0 ? HealthState.OK : HealthState.CRITICAL,
    summary:
      stuckOrders === 0
        ? 'Every confirmed order has reached Shopify.'
        : `${stuckOrders} order${stuckOrders === 1 ? '' : 's'} failed to reach Shopify and need${
            stuckOrders === 1 ? 's' : ''
          } a retry.`,
    actionPath: stuckOrders === 0 ? null : '/orders',
  });

  // ---- Google Sheets
  if (!googleAccount) {
    checks.push({
      key: 'sheets',
      label: 'Google Sheets',
      state: HealthState.NOT_CONFIGURED,
      summary: 'No Google account connected.',
      actionPath: '/settings/sheets',
    });
  } else if (googleAccount.revokedAt || !googleAccount.isActive) {
    checks.push({
      key: 'sheets',
      label: 'Google Sheets',
      state: HealthState.CRITICAL,
      // The failure mode that matters: access was revoked weeks ago and every
      // order since has quietly failed to sync.
      summary: `Google access for ${googleAccount.email} was revoked — orders are not syncing.`,
      actionPath: '/settings/sheets',
    });
  } else if (!sheetConfig) {
    checks.push({
      key: 'sheets',
      label: 'Google Sheets',
      state: HealthState.WARNING,
      summary: 'Connected, but no spreadsheet is selected yet.',
      actionPath: '/settings/sheets',
    });
  } else {
    const failing = sheetConfig.lastSyncStatus === 'FAILED';
    checks.push({
      key: 'sheets',
      label: 'Google Sheets',
      state: failing ? HealthState.CRITICAL : HealthState.OK,
      summary: failing
        ? `The last sync failed: ${sheetConfig.lastError ?? 'unknown error'}`
        : sheetConfig.lastSyncedAt
          ? `Last synced ${sheetConfig.lastSyncedAt.toISOString()}`
          : 'Ready — no orders synced yet.',
      actionPath: '/settings/sheets',
    });
  }

  // ---- Pixels
  if (pixels.length === 0) {
    checks.push({
      key: 'pixels',
      label: 'Ad pixels',
      state: HealthState.NOT_CONFIGURED,
      summary: 'No pixels configured — conversions are not being reported.',
      actionPath: '/settings/pixels',
    });
  } else {
    const broken = pixels.filter((pixel) => pixel.lastError && pixel.totalSent === 0);

    checks.push({
      key: 'pixels',
      label: 'Ad pixels',
      state:
        broken.length > 0
          ? HealthState.CRITICAL
          : failedPixelEvents > 0
            ? HealthState.WARNING
            : HealthState.OK,
      summary:
        broken.length > 0
          ? `${broken.map((pixel) => pixel.label).join(', ')} ${
              broken.length === 1 ? 'has' : 'have'
            } never delivered an event.`
          : failedPixelEvents > 0
            ? `${failedPixelEvents} event${failedPixelEvents === 1 ? '' : 's'} failed in the last 24 hours.`
            : `${pixels.length} pixel${pixels.length === 1 ? '' : 's'} reporting normally.`,
      actionPath: '/settings/pixels',
    });
  }

  const overall =
    WORST_FIRST.find((state) => checks.some((check) => check.state === state)) ?? HealthState.OK;

  return { overall, checks, generatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Recomputes a range from `cod_orders`.
 *
 * Runs inline rather than through a queue when the range is short, because the
 * merchant is watching and a 30-day rebuild is one indexed query. Longer ranges
 * go to the worker — see `jobs/rebuildStats`.
 */
export async function rebuild(shopId: string, from: IsoDate, to: IsoDate): Promise<number> {
  const shop = await shopRepository.findAnalyticsContext(shopId);
  if (!shop) throw new NotFoundError('Shop not found');

  return repository.rebuildRange(
    shopId,
    resolveTimezone(shop.ianaTimezone ?? shop.timezone),
    from,
    to,
    shop.currencyCode,
  );
}

/** Ranges longer than this are handed to the worker instead of run inline. */
export const INLINE_REBUILD_DAYS = 31;

import type { DailyStat } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The analytics read model.
 *
 * This is arithmetic over stored rows, and the failures worth guarding against
 * are the ones that produce a number that looks plausible and is wrong:
 *
 *  - Averaging daily rates instead of dividing period totals, which lets a
 *    two-view day count as heavily as a two-thousand-view day.
 *  - Reporting an impossible ratio as zero rather than unknown, which tells a
 *    merchant their form converts nobody.
 *  - Dropping days with no orders, which silently rescales the chart and hides
 *    exactly the gap the merchant opened the dashboard to find.
 *
 * The repository is mocked: what is under test is the arithmetic, not SQL.
 */

const { findRange, findDay, liveCounters, rebuildRange, findAnalyticsContext } = vi.hoisted(() => ({
  findRange: vi.fn(),
  findDay: vi.fn(),
  liveCounters: vi.fn(),
  rebuildRange: vi.fn(),
  findAnalyticsContext: vi.fn(),
}));

vi.mock('./repository', () => ({ findRange, findDay, liveCounters, rebuildRange }));
vi.mock('../shop/repository', () => ({ findAnalyticsContext }));
vi.mock('../../db/prisma', () => ({ prisma: {} }));

const { breakdown, funnel, overview, resolveRange } = await import('./service');
const { Prisma } = await import('@prisma/client');
const { toDateColumn } = await import('../../lib/shopTime');

function row(date: string, overrides: Partial<DailyStat> = {}): DailyStat {
  return {
    id: `stat-${date}`,
    shopId: 'shop-1',
    date: toDateColumn(date),

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

    revenue: new Prisma.Decimal(0),
    cancelledValue: new Prisma.Decimal(0),
    returnedValue: new Prisma.Decimal(0),
    averageOrderValue: new Prisma.Decimal(0),
    currency: 'INR',

    blockedAttempts: 0,
    highRiskOrders: 0,
    otpSent: 0,
    otpVerified: 0,
    otpFailed: 0,

    sheetSyncSuccess: 0,
    sheetSyncFailed: 0,
    pixelEventsSent: 0,
    pixelEventsFailed: 0,

    ordersByCountry: {},
    ordersByCity: {},
    ordersByProduct: {},

    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DailyStat;
}

/** Fixes "today" in the shop's zone so the ranges are deterministic. */
function freezeClock(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();

  findAnalyticsContext.mockResolvedValue({
    id: 'shop-1',
    timezone: 'Asia/Kolkata',
    ianaTimezone: 'Asia/Kolkata',
    currencyCode: 'INR',
  });

  findRange.mockResolvedValue([]);
  findDay.mockResolvedValue(null);
  liveCounters.mockResolvedValue({ pendingPush: 0, awaitingReview: 0 });
});

describe('resolveRange', () => {
  it('cuts the range on the shop’s calendar, not the server’s', async () => {
    // 19:00 UTC on the 3rd is already the 4th in Delhi.
    freezeClock('2026-03-03T19:00:00Z');

    const range = await resolveRange('shop-1', { range: '7d' });

    expect(range.period.to).toBe('2026-03-04');
    expect(range.period.from).toBe('2026-02-26');
    expect(range.period.timezone).toBe('Asia/Kolkata');
  });

  it('compares against the equally long window immediately before', async () => {
    freezeClock('2026-03-04T06:00:00Z');

    const range = await resolveRange('shop-1', { range: '30d' });

    expect(range.period).toMatchObject({ from: '2026-02-03', to: '2026-03-04', days: 30 });
    expect(range.comparedTo).toMatchObject({ from: '2026-01-04', to: '2026-02-02', days: 30 });
  });

  it('rejects an inverted custom range', async () => {
    await expect(
      resolveRange('shop-1', { range: 'custom', from: '2026-03-10', to: '2026-03-01' }),
    ).rejects.toThrow(/must not be after/i);
  });

  it('rejects a range longer than a year', async () => {
    await expect(
      resolveRange('shop-1', { range: 'custom', from: '2024-01-01', to: '2026-01-01' }),
    ).rejects.toThrow(/cannot be longer/i);
  });

  it('requires both ends of a custom range', async () => {
    await expect(resolveRange('shop-1', { range: 'custom', from: '2026-03-01' })).rejects.toThrow(
      /both a start and an end/i,
    );
  });
});

describe('overview', () => {
  it('zero-fills days with no rows so the chart keeps its shape', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockImplementation(async (_shop: string, from: string) =>
      from === range.period.from ? [row('2026-03-01', { codOrders: 4 })] : [],
    );

    const result = await overview('shop-1', range);

    // Seven days requested, seven points returned — not one.
    expect(result.series).toHaveLength(7);
    expect(result.series.map((point) => point.date)).toEqual([
      '2026-02-26',
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
    expect(result.series[3]?.codOrders).toBe(4);
    expect(result.series[0]?.codOrders).toBe(0);
  });

  it('computes a period rate from period totals, not from daily averages', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockImplementation(async (_shop: string, from: string) =>
      from === range.period.from
        ? [
            // One tiny day at 50%, one busy day at 5%. The mean of the daily
            // rates is 27.5%; the true rate is 6 in 1002.
            row('2026-03-01', { formViews: 2, formSubmissions: 1 }),
            row('2026-03-02', { formViews: 1_000, formSubmissions: 5 }),
          ]
        : [],
    );

    const result = await overview('shop-1', range);

    expect(result.conversionRate?.value).toBe(0.6);
  });

  it('reports an unmeasurable rate as null rather than zero', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockResolvedValue([row('2026-03-01', { codOrders: 3, formViews: 0 })]);

    const result = await overview('shop-1', range);

    // No views recorded: the conversion rate is unknown. Zero would claim the
    // form converts nobody, which is a different and much worse statement.
    expect(result.conversionRate).toBeNull();
    expect(result.confirmationRate).not.toBeNull();
  });

  it('gives no percentage change when the previous period was empty', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockImplementation(async (_shop: string, from: string) =>
      from === range.period.from ? [row('2026-03-01', { codOrders: 5 })] : [],
    );

    const result = await overview('shop-1', range);

    expect(result.orders.value).toBe(5);
    expect(result.orders.previous).toBe(0);
    // "Up 100%" from nothing would be true of every first order.
    expect(result.orders.changePct).toBeNull();
    expect(result.orders.direction).toBe('up');
  });

  it('weights the average order value by orders, not by days', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockImplementation(async (_shop: string, from: string) =>
      from === range.period.from
        ? [
            row('2026-03-01', { codOrders: 1, revenue: new Prisma.Decimal(1_000) }),
            row('2026-03-02', { codOrders: 9, revenue: new Prisma.Decimal(900) }),
          ]
        : [],
    );

    const result = await overview('shop-1', range);

    // 1900 / 10 = 190. Averaging the two daily averages would give 550.
    expect(result.averageOrderValue.value).toBe('190.00');
  });

  it('sends money as a decimal string, never a float', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockResolvedValue([row('2026-03-01', { codOrders: 1, revenue: new Prisma.Decimal('1234.56') })]);

    const result = await overview('shop-1', range);

    expect(result.revenue.value).toBe('1234.56');
    expect(typeof result.revenue.value).toBe('string');
  });

  it('carries live queue depths that no daily aggregate could hold', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    liveCounters.mockResolvedValue({ pendingPush: 3, awaitingReview: 2 });
    findDay.mockResolvedValue(row('2026-03-04', { codOrders: 7, revenue: new Prisma.Decimal(700) }));

    const result = await overview('shop-1', range);

    expect(result.today).toEqual({
      orders: 7,
      revenue: '700.00',
      pendingPush: 3,
      awaitingReview: 2,
    });
  });
});

describe('funnel', () => {
  it('reports the drop into each stage, not only the share of the top', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockResolvedValue([
      row('2026-03-01', {
        formViews: 1_000,
        formStarts: 400,
        codOrders: 100,
        confirmedOrders: 90,
        pushedOrders: 45,
      }),
    ]);

    const result = await funnel('shop-1', range);

    expect(result.stages.map((stage) => stage.key)).toEqual([
      'views',
      'starts',
      'submissions',
      'accepted',
      'pushed',
    ]);

    // The stage that diagnoses the problem: half of everything that passed
    // fraud checks never reached Shopify.
    expect(result.stages[4]).toMatchObject({ conversionFromPrevious: 50, conversionFromStart: 4.5 });
    expect(result.stages[0]?.conversionFromPrevious).toBeNull();
  });

  it('drops the view stages rather than drawing them as zero', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockResolvedValue([row('2026-03-01', { codOrders: 10, confirmedOrders: 9, pushedOrders: 9 })]);

    const result = await funnel('shop-1', range);

    // A funnel whose first bar is zero and second is ten reads as a data fault
    // and discredits the stages that are real.
    expect(result.viewsMissing).toBe(true);
    expect(result.stages[0]?.key).toBe('submissions');
    expect(result.stages).toHaveLength(3);
  });
});

describe('breakdown', () => {
  it('sums a dimension across the range and ranks it', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockResolvedValue([
      row('2026-03-01', { codOrders: 6, revenue: new Prisma.Decimal(600), ordersByCountry: { IN: 4, AE: 2 } }),
      row('2026-03-02', { codOrders: 3, revenue: new Prisma.Decimal(300), ordersByCountry: { AE: 3 } }),
    ]);

    const result = await breakdown('shop-1', range, 'country');

    expect(result.rows.map((entry) => [entry.key, entry.orders])).toEqual([
      ['AE', 5],
      ['IN', 4],
    ]);
    expect(result.totalOrders).toBe(9);
    expect(result.rows[0]?.share).toBe(55.6);
    // Rendered for a human, keyed for a machine.
    expect(result.rows[0]?.label).toBe('United Arab Emirates');
  });

  it('folds the tail into one Other row', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    const countries: Record<string, number> = {};
    for (let index = 0; index < 12; index += 1) {
      countries[`C${index}`] = 12 - index;
    }

    findRange.mockResolvedValue([
      row('2026-03-01', { codOrders: 78, revenue: new Prisma.Decimal(780), ordersByCountry: countries }),
    ]);

    const result = await breakdown('shop-1', range, 'country');

    // Past about eight bars a ranking stops being readable and the tail pushes
    // the rows that matter off screen.
    expect(result.rows).toHaveLength(8);
    expect(result.other).not.toBeNull();
    // Twelve countries at 12, 11, … 1 orders. The top eight are 12 down to 5;
    // the four that fall past the cut are 4, 3, 2 and 1.
    expect(result.other?.orders).toBe(4 + 3 + 2 + 1);
    expect(result.other?.label).toBe('Other (4)');
  });

  it('keeps a product’s own revenue rather than apportioning it', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    findRange.mockResolvedValue([
      row('2026-03-01', {
        codOrders: 2,
        revenue: new Prisma.Decimal(500),
        ordersByProduct: {
          'gid://shopify/Product/1': { title: 'Kurta', orders: 1, revenue: 400 },
          'gid://shopify/Product/2': { title: 'Dupatta', orders: 1, revenue: 100 },
        },
      }),
    ]);

    const result = await breakdown('shop-1', range, 'product');

    expect(result.rows[0]).toMatchObject({ label: 'Kurta', orders: 1, revenue: '400.00' });
  });

  it('returns an empty breakdown rather than throwing when nothing was recorded', async () => {
    freezeClock('2026-03-04T06:00:00Z');
    const range = await resolveRange('shop-1', { range: '7d' });

    const result = await breakdown('shop-1', range, 'city');

    expect(result.rows).toEqual([]);
    expect(result.other).toBeNull();
    expect(result.totalOrders).toBe(0);
  });
});

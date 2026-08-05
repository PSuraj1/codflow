import { CodOrderStatus, Prisma, RiskAction, RiskLevel, SyncStatus, type DailyStat } from '@prisma/client';
import { prisma } from '../../db/prisma';
import {
  endOfShopDay,
  fromDateColumn,
  startOfShopDay,
  toDateColumn,
  toShopDate,
  type IsoDate,
} from '../../lib/shopTime';

/**
 * `DailyStat` persistence.
 *
 * One row per shop per day, written incrementally as things happen and read as
 * a contiguous range. Two properties matter more than anything else here:
 *
 *  1. **Writes are atomic.** Two orders landing in the same second must both be
 *     counted. Every counter goes through Prisma's `increment`, which compiles
 *     to `SET "codOrders" = "codOrders" + $1` — a read-modify-write in
 *     application code would lose one of them.
 *  2. **The JSON maps need the row locked.** `ordersByCountry` and friends are
 *     merged rather than incremented, and there is no single-statement form of
 *     "add one to this key" that also creates the key. So the merge happens
 *     inside a transaction that holds the row, which serialises writes for one
 *     shop-day and nothing else. The alternative — dropping the maps and
 *     grouping `cod_orders` at read time — turns the breakdown query into a
 *     scan that gets slower every month the merchant uses the app.
 */

/** Counter columns a caller may increment. All optional; all default to zero. */
export interface StatDelta {
  formViews?: number;
  formStarts?: number;
  formSubmissions?: number;
  buttonClicks?: number;

  codOrders?: number;
  confirmedOrders?: number;
  pushedOrders?: number;
  cancelledOrders?: number;
  returnedOrders?: number;
  fulfilledOrders?: number;
  abandonedOrders?: number;

  revenue?: Prisma.Decimal;
  cancelledValue?: Prisma.Decimal;
  returnedValue?: Prisma.Decimal;

  blockedAttempts?: number;
  highRiskOrders?: number;
  otpSent?: number;
  otpVerified?: number;
  otpFailed?: number;

  sheetSyncSuccess?: number;
  sheetSyncFailed?: number;
  pixelEventsSent?: number;
  pixelEventsFailed?: number;
}

/** Dimensional keys carried alongside a delta, merged into the JSON maps. */
export interface StatDimensions {
  /** ISO 3166-1 alpha-2. */
  countryCode?: string | null;
  city?: string | null;
  products?: readonly { gid: string; title: string; quantity: number; revenue: Prisma.Decimal }[];
}

type CountMap = Record<string, number>;
type ProductMap = Record<string, { title: string; orders: number; revenue: number }>;

const COUNTER_KEYS = [
  'formViews',
  'formStarts',
  'formSubmissions',
  'buttonClicks',
  'codOrders',
  'confirmedOrders',
  'pushedOrders',
  'cancelledOrders',
  'returnedOrders',
  'fulfilledOrders',
  'abandonedOrders',
  'blockedAttempts',
  'highRiskOrders',
  'otpSent',
  'otpVerified',
  'otpFailed',
  'sheetSyncSuccess',
  'sheetSyncFailed',
  'pixelEventsSent',
  'pixelEventsFailed',
] as const;

const MONEY_KEYS = ['revenue', 'cancelledValue', 'returnedValue'] as const;

function asCountMap(value: Prisma.JsonValue | null): CountMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const result: CountMap = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number' && Number.isFinite(count)) result[key] = count;
  }
  return result;
}

function asProductMap(value: Prisma.JsonValue | null): ProductMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const result: ProductMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const record = entry as Record<string, unknown>;
    result[key] = {
      title: typeof record.title === 'string' ? record.title : key,
      orders: typeof record.orders === 'number' ? record.orders : 0,
      revenue: typeof record.revenue === 'number' ? record.revenue : 0,
    };
  }
  return result;
}

/**
 * Whether a delta touches anything at all.
 *
 * Callers pass whatever they know without checking, so a no-op delta is normal
 * traffic — and taking a row lock for it would be pure contention.
 */
function isEmpty(delta: StatDelta, dimensions: StatDimensions): boolean {
  const hasCounter = COUNTER_KEYS.some((key) => (delta[key] ?? 0) !== 0);
  const hasMoney = MONEY_KEYS.some((key) => delta[key] !== undefined && !delta[key]?.isZero());
  const hasDimension =
    Boolean(dimensions.countryCode) ||
    Boolean(dimensions.city) ||
    (dimensions.products?.length ?? 0) > 0;

  return !hasCounter && !hasMoney && !hasDimension;
}

/**
 * Applies one delta to a shop's day.
 *
 * `currency` seeds the row on creation only. A shop that changes its currency
 * mid-history keeps the old rows as they were rather than restating them,
 * because restating would mean re-converting amounts at a rate nobody recorded.
 */
export async function applyDelta(
  shopId: string,
  date: IsoDate,
  currency: string,
  delta: StatDelta,
  dimensions: StatDimensions = {},
): Promise<void> {
  if (isEmpty(delta, dimensions)) return;

  const dateColumn = toDateColumn(date);
  const needsMerge =
    Boolean(dimensions.countryCode) ||
    Boolean(dimensions.city) ||
    (dimensions.products?.length ?? 0) > 0;

  const counterUpdate: Prisma.DailyStatUpdateInput = {};

  for (const key of COUNTER_KEYS) {
    const amount = delta[key] ?? 0;
    if (amount !== 0) {
      (counterUpdate as Record<string, unknown>)[key] = { increment: amount };
    }
  }

  for (const key of MONEY_KEYS) {
    const amount = delta[key];
    if (amount !== undefined && !amount.isZero()) {
      (counterUpdate as Record<string, unknown>)[key] = { increment: amount };
    }
  }

  if (!needsMerge) {
    // The common path — a counter with no dimensions — is a single atomic
    // statement with no lock at all.
    await prisma.dailyStat.upsert({
      where: { shopId_date: { shopId, date: dateColumn } },
      create: { shopId, date: dateColumn, currency, ...createValues(delta) },
      update: counterUpdate,
    });

    await recalculateAverage(shopId, dateColumn);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.dailyStat.upsert({
      where: { shopId_date: { shopId, date: dateColumn } },
      create: { shopId, date: dateColumn, currency },
      // Deliberately empty: this call only guarantees the row exists so the
      // lock below has something to take. The real update happens after it.
      update: {},
    });

    // `FOR UPDATE` rather than an optimistic retry loop: contention is one row
    // per shop per day, the transaction is three statements long, and a lost
    // update here would silently under-count a country for good.
    await tx.$queryRaw`
      SELECT id FROM daily_stats
      WHERE "shopId" = ${shopId} AND date = ${dateColumn}::date
      FOR UPDATE
    `;

    const current = await tx.dailyStat.findUnique({
      where: { shopId_date: { shopId, date: dateColumn } },
    });

    if (!current) return;

    const countries = asCountMap(current.ordersByCountry);
    const cities = asCountMap(current.ordersByCity);
    const products = asProductMap(current.ordersByProduct);

    if (dimensions.countryCode) {
      const key = dimensions.countryCode.toUpperCase();
      countries[key] = (countries[key] ?? 0) + 1;
    }

    if (dimensions.city) {
      // Keyed on the merchant-visible spelling, trimmed. Normalising further
      // (case folding, transliteration) would merge "Delhi" and "delhi" but
      // also merge cities that only differ by accent in some locales.
      const key = dimensions.city.trim();
      if (key) cities[key] = (cities[key] ?? 0) + 1;
    }

    for (const product of dimensions.products ?? []) {
      const existing = products[product.gid] ?? { title: product.title, orders: 0, revenue: 0 };
      products[product.gid] = {
        title: product.title || existing.title,
        orders: existing.orders + 1,
        revenue: existing.revenue + Number(product.revenue),
      };
    }

    await tx.dailyStat.update({
      where: { shopId_date: { shopId, date: dateColumn } },
      data: {
        ...counterUpdate,
        ordersByCountry: countries as Prisma.InputJsonValue,
        ordersByCity: cities as Prisma.InputJsonValue,
        ordersByProduct: products as unknown as Prisma.InputJsonValue,
      },
    });
  });

  await recalculateAverage(shopId, dateColumn);
}

/** Non-zero fields of a delta, for the row's first write. */
function createValues(delta: StatDelta): Record<string, number | Prisma.Decimal> {
  const values: Record<string, number | Prisma.Decimal> = {};

  for (const key of COUNTER_KEYS) {
    const amount = delta[key] ?? 0;
    if (amount !== 0) values[key] = amount;
  }

  for (const key of MONEY_KEYS) {
    const amount = delta[key];
    if (amount !== undefined && !amount.isZero()) values[key] = amount;
  }

  return values;
}

/**
 * Keeps `averageOrderValue` consistent with the two columns it derives from.
 *
 * Stored rather than divided at read time because the dashboard shows an
 * average per *day*, and a range average is not the mean of the daily means —
 * it has to be weighted by each day's order count, which the reader would have
 * to know to do. Storing it means the one place that computes it is here.
 */
async function recalculateAverage(shopId: string, date: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE daily_stats
    SET "averageOrderValue" = CASE
      WHEN "codOrders" > 0 THEN ROUND(revenue / "codOrders", 2)
      ELSE 0
    END
    WHERE "shopId" = ${shopId} AND date = ${date}::date
  `;
}

/** Every stored day in a range, ascending. Missing days simply are not rows. */
export async function findRange(shopId: string, from: IsoDate, to: IsoDate): Promise<DailyStat[]> {
  return prisma.dailyStat.findMany({
    where: {
      shopId,
      date: { gte: toDateColumn(from), lte: toDateColumn(to) },
    },
    orderBy: { date: 'asc' },
  });
}

/** The row for one day, or null when nothing happened on it. */
export async function findDay(shopId: string, date: IsoDate): Promise<DailyStat | null> {
  return prisma.dailyStat.findUnique({
    where: { shopId_date: { shopId, date: toDateColumn(date) } },
  });
}

/**
 * Counters the aggregate cannot answer, read live from `cod_orders`.
 *
 * These are *current state* rather than things that happened on a day: how many
 * orders are waiting to reach Shopify right now, how many are held for review.
 * A daily aggregate can only record transitions, and a merchant looking at this
 * card wants the queue depth as it stands.
 */
export interface LiveCounters {
  readonly pendingPush: number;
  readonly awaitingReview: number;
}

/**
 * Ceiling on the dashboard's live counters.
 *
 * These run on every dashboard load, and an exact `count()` over the stuck set
 * is a full index scan — largest exactly when a merchant is refreshing because
 * something is wrong. A merchant past a thousand needs a bulk action, not a
 * precise figure, so the tile reads "1,000+" and the Orders screen carries the
 * detail.
 */
const LIVE_COUNT_CAP = 1_000;

/** Counts rows up to a ceiling, without scanning past it. */
async function countCapped(where: Prisma.CodOrderWhereInput): Promise<number> {
  const rows = await prisma.codOrder.findMany({
    where,
    take: LIVE_COUNT_CAP,
    select: { id: true },
  });

  return rows.length;
}

export async function liveCounters(shopId: string): Promise<LiveCounters> {
  const [pendingPush, awaitingReview] = await Promise.all([
    countCapped({
      shopId,
      // Confirmed or previously failed, and not yet in Shopify. `FAILED` is
      // included because a push that failed is still an order the merchant is
      // owed — leaving it out is how a stuck queue looks like an empty one.
      // Blocked orders are excluded to match `orders/repository.stuckBase`, so
      // this tile and the screen it links to cannot disagree.
      status: { in: [CodOrderStatus.CONFIRMED, CodOrderStatus.FAILED, CodOrderStatus.PENDING_OTP] },
      shopifyOrderGid: null,
      riskAction: { not: RiskAction.BLOCK },
    }),
    countCapped({
      shopId,
      riskAction: RiskAction.REVIEW,
      shopifyOrderGid: null,
      status: { notIn: [CodOrderStatus.CANCELLED, CodOrderStatus.ABANDONED] },
    }),
  ]);

  return { pendingPush, awaitingReview };
}


/** Orders created in a window, with only the columns the rebuild needs. */
type RebuildOrder = Pick<
  Prisma.CodOrderGetPayload<{
    select: {
      status: true;
      createdAt: true;
      cancelledAt: true;
      returnedAt: true;
      fulfilledAt: true;
      pushedAt: true;
      total: true;
      currency: true;
      countryCode: true;
      city: true;
      riskLevel: true;
      riskAction: true;
      lineItems: true;
      sheetSyncStatus: true;
    };
  }>,
  | 'status'
  | 'createdAt'
  | 'cancelledAt'
  | 'returnedAt'
  | 'fulfilledAt'
  | 'pushedAt'
  | 'total'
  | 'currency'
  | 'countryCode'
  | 'city'
  | 'riskLevel'
  | 'riskAction'
  | 'lineItems'
  | 'sheetSyncStatus'
>;

/**
 * Reads the orders a rebuild needs.
 *
 * Bounded by the window rather than paged: a rebuild covers at most a year, and
 * the index on `(shopId, createdAt)` makes this the one query in the module
 * that is allowed to touch `cod_orders` in bulk. It runs from a queue, never
 * from a request.
 */
export async function ordersForRebuild(
  shopId: string,
  from: Date,
  to: Date,
): Promise<RebuildOrder[]> {
  return prisma.codOrder.findMany({
    where: { shopId, createdAt: { gte: from, lt: to } },
    select: {
      status: true,
      createdAt: true,
      cancelledAt: true,
      returnedAt: true,
      fulfilledAt: true,
      pushedAt: true,
      total: true,
      currency: true,
      countryCode: true,
      city: true,
      riskLevel: true,
      riskAction: true,
      lineItems: true,
      sheetSyncStatus: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

interface RebuiltDay {
  date: IsoDate;
  currency: string;
  counters: Record<string, number>;
  revenue: Prisma.Decimal;
  cancelledValue: Prisma.Decimal;
  returnedValue: Prisma.Decimal;
  countries: CountMap;
  cities: CountMap;
  products: ProductMap;
}

interface RebuildLineItem {
  productGid?: string;
  variantGid?: string;
  title?: string;
  quantity?: number;
  price?: string | number;
}

function lineItemsOf(value: Prisma.JsonValue): RebuildLineItem[] {
  return Array.isArray(value) ? (value as unknown as RebuildLineItem[]) : [];
}

/**
 * Recomputes whole days from `cod_orders` and replaces the stored rows.
 *
 * The reconciliation path. Incremental counters drift for reasons that are not
 * bugs — a delivery Shopify retried after our handler had already run, a
 * deploy that dropped an in-flight increment — and without a way to restate
 * them the merchant's only recourse is to distrust the dashboard.
 *
 * Deleting and re-inserting rather than updating in place is deliberate: an
 * update would leave counters for events that no longer exist, which is the
 * exact drift this is meant to remove. What it *cannot* restore is storefront
 * telemetry (form views, button clicks) — those have no source outside the
 * aggregate — so those columns are carried across from the existing row.
 */
export async function rebuildRange(
  shopId: string,
  timezone: string,
  from: IsoDate,
  to: IsoDate,
  currencyFallback: string,
): Promise<number> {
  const windowStart = startOfShopDay(from, timezone);
  const windowEnd = endOfShopDay(to, timezone);

  const [orders, existing] = await Promise.all([
    ordersForRebuild(shopId, windowStart, windowEnd),
    findRange(shopId, from, to),
  ]);

  const telemetry = new Map(
    existing.map((row) => [
      fromDateColumn(row.date),
      {
        formViews: row.formViews,
        formStarts: row.formStarts,
        formSubmissions: row.formSubmissions,
        buttonClicks: row.buttonClicks,
      },
    ]),
  );

  const days = new Map<IsoDate, RebuiltDay>();

  const dayFor = (date: IsoDate, currency: string): RebuiltDay => {
    const found = days.get(date);
    if (found) return found;

    const created: RebuiltDay = {
      date,
      currency,
      counters: {},
      revenue: new Prisma.Decimal(0),
      cancelledValue: new Prisma.Decimal(0),
      returnedValue: new Prisma.Decimal(0),
      countries: {},
      cities: {},
      products: {},
    };

    days.set(date, created);
    return created;
  };

  const bump = (day: RebuiltDay, key: string, amount = 1): void => {
    day.counters[key] = (day.counters[key] ?? 0) + amount;
  };

  for (const order of orders) {
    const created = toShopDate(order.createdAt, timezone);
    const day = dayFor(created, order.currency || currencyFallback);

    bump(day, 'codOrders');

    // Blocked attempts are counted on the day the order arrived, not the day a
    // human reviewed it — the merchant is asking "how much did fraud stop
    // yesterday", which is a question about yesterday's traffic.
    if (order.riskAction === 'BLOCK') bump(day, 'blockedAttempts');
    if (order.riskLevel === RiskLevel.HIGH || order.riskLevel === RiskLevel.CRITICAL) {
      bump(day, 'highRiskOrders');
    }

    if (order.status === CodOrderStatus.ABANDONED) bump(day, 'abandonedOrders');

    if (order.sheetSyncStatus === SyncStatus.SUCCESS) bump(day, 'sheetSyncSuccess');
    else if (order.sheetSyncStatus === SyncStatus.FAILED) bump(day, 'sheetSyncFailed');

    // Revenue is recognised on the order's own day even when it is confirmed
    // later, so a day's revenue never changes retroactively once it has passed.
    // An order the fraud engine blocked is deliberately excluded: it is an
    // attempt, not a sale, and counting it would inflate the very number the
    // merchant uses to judge whether the fraud rules are worth their cost.
    const counted =
      order.status !== CodOrderStatus.ABANDONED &&
      order.status !== CodOrderStatus.DRAFT &&
      order.riskAction !== RiskAction.BLOCK;

    if (counted) {
      day.revenue = day.revenue.add(order.total);
      bump(day, 'confirmedOrders');

      if (order.countryCode) {
        const key = order.countryCode.toUpperCase();
        day.countries[key] = (day.countries[key] ?? 0) + 1;
      }

      const city = order.city?.trim();
      if (city) day.cities[city] = (day.cities[city] ?? 0) + 1;

      for (const item of lineItemsOf(order.lineItems)) {
        const gid = item.productGid ?? item.variantGid;
        if (!gid) continue;

        const quantity = Number(item.quantity ?? 1);
        const price = Number(item.price ?? 0);
        const entry = day.products[gid] ?? { title: item.title ?? gid, orders: 0, revenue: 0 };

        day.products[gid] = {
          title: item.title ?? entry.title,
          orders: entry.orders + 1,
          revenue: entry.revenue + price * quantity,
        };
      }
    }

    // Lifecycle transitions land on the day they happened, which is usually not
    // the day the order was created.
    if (order.pushedAt) bump(dayFor(toShopDate(order.pushedAt, timezone), day.currency), 'pushedOrders');

    if (order.cancelledAt) {
      const target = dayFor(toShopDate(order.cancelledAt, timezone), day.currency);
      bump(target, 'cancelledOrders');
      target.cancelledValue = target.cancelledValue.add(order.total);
    }

    if (order.returnedAt) {
      const target = dayFor(toShopDate(order.returnedAt, timezone), day.currency);
      bump(target, 'returnedOrders');
      target.returnedValue = target.returnedValue.add(order.total);
    }

    if (order.fulfilledAt) {
      bump(dayFor(toShopDate(order.fulfilledAt, timezone), day.currency), 'fulfilledOrders');
    }
  }

  // Transitions can fall outside the requested window — an order created in
  // March and cancelled in April. Those days are dropped rather than written,
  // because writing them would replace a day the caller did not ask to rebuild
  // with a partial recomputation of it.
  for (const date of [...days.keys()]) {
    if (date < from || date > to) days.delete(date);
  }

  await prisma.$transaction([
    prisma.dailyStat.deleteMany({
      where: { shopId, date: { gte: toDateColumn(from), lte: toDateColumn(to) } },
    }),
    prisma.dailyStat.createMany({
      data: [...days.values()].map((day) => {
        const carried = telemetry.get(day.date);
        const orderCount = day.counters.codOrders ?? 0;

        return {
          shopId,
          date: toDateColumn(day.date),
          currency: day.currency,

          formViews: carried?.formViews ?? 0,
          formStarts: carried?.formStarts ?? 0,
          formSubmissions: carried?.formSubmissions ?? orderCount,
          buttonClicks: carried?.buttonClicks ?? 0,

          codOrders: orderCount,
          confirmedOrders: day.counters.confirmedOrders ?? 0,
          pushedOrders: day.counters.pushedOrders ?? 0,
          cancelledOrders: day.counters.cancelledOrders ?? 0,
          returnedOrders: day.counters.returnedOrders ?? 0,
          fulfilledOrders: day.counters.fulfilledOrders ?? 0,
          abandonedOrders: day.counters.abandonedOrders ?? 0,

          revenue: day.revenue,
          cancelledValue: day.cancelledValue,
          returnedValue: day.returnedValue,
          averageOrderValue:
            orderCount > 0 ? day.revenue.dividedBy(orderCount).toDecimalPlaces(2) : new Prisma.Decimal(0),

          blockedAttempts: day.counters.blockedAttempts ?? 0,
          highRiskOrders: day.counters.highRiskOrders ?? 0,

          sheetSyncSuccess: day.counters.sheetSyncSuccess ?? 0,
          sheetSyncFailed: day.counters.sheetSyncFailed ?? 0,

          ordersByCountry: day.countries as Prisma.InputJsonValue,
          ordersByCity: day.cities as Prisma.InputJsonValue,
          ordersByProduct: day.products as unknown as Prisma.InputJsonValue,
        };
      }),
    }),
  ]);

  return days.size;
}

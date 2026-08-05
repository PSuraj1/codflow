import { Prisma, RiskAction, RiskLevel, type CodOrder } from '@prisma/client';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import { toShopDate, type IsoDate } from '../../lib/shopTime';
import * as shopRepository from '../shop/repository';
import * as repository from './repository';
import type { StatDelta, StatDimensions } from './repository';

const log = createLogger('analytics-stats');

/**
 * The recorder.
 *
 * Every counter on the dashboard is incremented from here and nowhere else, so
 * there is exactly one definition of what "a confirmed order" means rather than
 * one per call site that quietly disagrees.
 *
 * **Nothing in this file is allowed to throw at its caller.** These calls sit
 * inside order creation, the push pipeline and webhook handlers — paths where a
 * failure has a real consequence for the merchant. A dashboard counter that
 * misses an increment is a number that can be rebuilt; an order that fails to
 * reach Shopify because the analytics write timed out is a lost sale. So every
 * entry point catches, logs and returns.
 *
 * The rebuild path exists precisely because of that trade: `POST /rebuild`
 * recomputes any range from `cod_orders`, which is the source of truth.
 */

/** Resolved once per record call: the shop's day and its currency. */
interface ShopClock {
  readonly shopId: string;
  readonly date: IsoDate;
  readonly currency: string;
}

async function clockFor(shopId: string, at: Date): Promise<ShopClock | null> {
  const shop = await shopRepository.findAnalyticsContext(shopId);
  if (!shop) return null;

  return {
    shopId,
    date: toShopDate(at, shop.ianaTimezone ?? shop.timezone),
    currency: shop.currencyCode,
  };
}

async function record(
  shopId: string,
  at: Date,
  delta: StatDelta,
  dimensions: StatDimensions = {},
): Promise<void> {
  try {
    const clock = await clockFor(shopId, at);
    if (!clock) return;

    await repository.applyDelta(clock.shopId, clock.date, clock.currency, delta, dimensions);
  } catch (error) {
    log.error(
      { err: toError(error), shopId, delta },
      'Could not record analytics — the dashboard will need a rebuild for this day',
    );
  }
}

// ---------------------------------------------------------------------------
// Storefront telemetry
// ---------------------------------------------------------------------------

/**
 * A shopper saw a COD button.
 *
 * The denominator of the conversion rate, and the only number here that cannot
 * be reconstructed from the database — there is no row for "someone looked at a
 * product page". Which is also why the telemetry endpoint accepts it
 * unauthenticated: the alternative is no denominator at all.
 */
export async function recordFormView(shopId: string, at = new Date()): Promise<void> {
  await record(shopId, at, { formViews: 1 });
}

/** A shopper opened the COD form. */
export async function recordFormStart(shopId: string, at = new Date()): Promise<void> {
  await record(shopId, at, { formStarts: 1 });
}

/** A shopper clicked a COD button. */
export async function recordButtonClick(shopId: string, at = new Date()): Promise<void> {
  await record(shopId, at, { buttonClicks: 1 });
}

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

interface OrderLineItem {
  productGid?: string;
  variantGid?: string;
  title?: string;
  quantity?: number;
  price?: string | number;
}

function productsOf(order: CodOrder): StatDimensions['products'] {
  const items: OrderLineItem[] = Array.isArray(order.lineItems)
    ? (order.lineItems as unknown as OrderLineItem[])
    : [];

  return items
    .filter((item) => Boolean(item.productGid ?? item.variantGid))
    .map((item) => ({
      gid: (item.productGid ?? item.variantGid) as string,
      title: item.title ?? '',
      quantity: Number(item.quantity ?? 1),
      revenue: new Prisma.Decimal(Number(item.price ?? 0) * Number(item.quantity ?? 1)),
    }));
}

/**
 * An order was submitted.
 *
 * Counted on the day the shopper placed it, with its full value, even though it
 * may not reach Shopify for hours. Recognising revenue on the push date instead
 * would make yesterday's total change overnight, and a number that moves after
 * the day has closed is one no merchant can reconcile against anything.
 *
 * A blocked order is counted as a submission and a blocked attempt, but carries
 * no revenue and no dimensions — it was an attempt, not a sale.
 */
export async function recordOrderCreated(order: CodOrder): Promise<void> {
  const blocked = order.riskAction === RiskAction.BLOCK;
  const highRisk = order.riskLevel === RiskLevel.HIGH || order.riskLevel === RiskLevel.CRITICAL;

  const delta: StatDelta = {
    codOrders: 1,
    formSubmissions: 1,
    ...(blocked ? { blockedAttempts: 1 } : { confirmedOrders: 1, revenue: order.total }),
    ...(highRisk ? { highRiskOrders: 1 } : {}),
  };

  await record(
    order.shopId,
    order.createdAt,
    delta,
    blocked
      ? {}
      : {
          countryCode: order.countryCode,
          city: order.city,
          products: productsOf(order),
        },
  );
}

/** An order reached Shopify. */
export async function recordOrderPushed(order: CodOrder, at = new Date()): Promise<void> {
  await record(order.shopId, at, { pushedOrders: 1 });
}

/**
 * An order was cancelled.
 *
 * Recorded on the cancellation date rather than the order date, so a cancelled
 * order shows as revenue on Monday and a cancellation on Thursday — which is
 * what actually happened, and what the merchant's own books will say.
 */
export async function recordOrderCancelled(
  shopId: string,
  value: Prisma.Decimal,
  at = new Date(),
): Promise<void> {
  await record(shopId, at, { cancelledOrders: 1, cancelledValue: value });
}

/** A delivered order came back. */
export async function recordOrderReturned(
  shopId: string,
  value: Prisma.Decimal,
  at = new Date(),
): Promise<void> {
  await record(shopId, at, { returnedOrders: 1, returnedValue: value });
}

/** An order was delivered — the only outcome that makes a COD order real money. */
export async function recordOrderFulfilled(shopId: string, at = new Date()): Promise<void> {
  await record(shopId, at, { fulfilledOrders: 1 });
}

/** A form was started and never submitted. */
export async function recordOrderAbandoned(shopId: string, at = new Date()): Promise<void> {
  await record(shopId, at, { abandonedOrders: 1 });
}

// ---------------------------------------------------------------------------
// Subsystems
// ---------------------------------------------------------------------------

export async function recordSheetSync(
  shopId: string,
  outcome: 'success' | 'failed',
  at = new Date(),
): Promise<void> {
  await record(shopId, at, outcome === 'success' ? { sheetSyncSuccess: 1 } : { sheetSyncFailed: 1 });
}

export async function recordPixelEvents(
  shopId: string,
  sent: number,
  failed: number,
  at = new Date(),
): Promise<void> {
  await record(shopId, at, { pixelEventsSent: sent, pixelEventsFailed: failed });
}

export async function recordOtp(
  shopId: string,
  outcome: 'sent' | 'verified' | 'failed',
  at = new Date(),
): Promise<void> {
  const delta: StatDelta =
    outcome === 'sent' ? { otpSent: 1 } : outcome === 'verified' ? { otpVerified: 1 } : { otpFailed: 1 };

  await record(shopId, at, delta);
}

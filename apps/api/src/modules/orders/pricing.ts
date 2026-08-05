import { Prisma } from '@prisma/client';
import type { Session } from '@shopify/shopify-api';
import { adminGraphql } from '../../shopify/graphql';
import {
  VARIANTS_BY_IDS_QUERY,
  type VariantNode,
  type VariantsResponse,
} from '../../shopify/queries/variant';
import { BadRequestError, ValidationError } from '../../lib/errors';
import { toVariantGid } from './dto';

/**
 * Server-side pricing.
 *
 * The rule this module exists to enforce: **a price never comes from the
 * browser**. The submission supplies variant ids and quantities; everything
 * monetary is resolved here against the Shopify Admin API and recomputed from
 * the merchant's own settings.
 *
 * Arithmetic uses `Prisma.Decimal` rather than JavaScript numbers. Floating
 * point cannot represent most decimal fractions exactly — `0.1 + 0.2` is famously
 * not `0.3` — and on a COD order those fractions of a currency unit are what a
 * courier actually collects in cash. Decimal also avoids the trap of scaling by
 * 100: not every currency has two decimal places (JPY has none, KWD has three),
 * so a cents-based integer would quietly mis-price entire markets.
 */

export interface ResolvedLineItem {
  readonly variantGid: string;
  readonly productGid: string;
  readonly title: string;
  readonly variantTitle: string;
  readonly sku: string | null;
  readonly quantity: number;
  /** Unit price, straight from Shopify. Never from the request. */
  readonly price: string;
  readonly lineTotal: string;
  readonly image: string | null;
}

export interface PricedOrder {
  readonly lineItems: readonly ResolvedLineItem[];
  readonly subtotal: Prisma.Decimal;
  readonly shippingFee: Prisma.Decimal;
  readonly codFee: Prisma.Decimal;
  /// Combined price of the tick-box add-ons the shopper accepted.
  readonly bumpTotal: Prisma.Decimal;
  readonly discount: Prisma.Decimal;
  readonly total: Prisma.Decimal;
}

/** Merchant COD economics, as the pricing rules need them. */
export interface PricingSettings {
  readonly codFeeEnabled: boolean;
  readonly codFeeAmount: Prisma.Decimal | null;
  readonly codFeeIsPercent: boolean;
  readonly shippingFee: Prisma.Decimal | null;
  readonly freeShippingAbove: Prisma.Decimal | null;
  readonly minOrderValue: Prisma.Decimal | null;
  readonly maxOrderValue: Prisma.Decimal | null;
}

const ZERO = new Prisma.Decimal(0);

/** Rounds to a currency's own precision. */
function round(value: Prisma.Decimal, decimalPlaces: number): Prisma.Decimal {
  return value.toDecimalPlaces(decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Minor-unit count for a currency.
 *
 * Rounding a Kuwaiti dinar to two places loses a fils, and rounding yen to two
 * places invents a fraction of a currency unit that cannot be paid in cash —
 * which on a COD order means a courier who cannot make the collection balance.
 */
function currencyPrecision(currencyCode: string): number {
  const zeroDecimal = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'XAF', 'XOF'];
  const threeDecimal = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];

  const code = currencyCode.toUpperCase();
  if (zeroDecimal.includes(code)) return 0;
  if (threeDecimal.includes(code)) return 3;
  return 2;
}

/**
 * Resolves submitted line items against Shopify.
 *
 * Also the availability gate. A COD order for something out of stock or on an
 * archived product is worse than a rejected one: the merchant only finds out
 * when they try to fulfil it, having already paid for the courier.
 */
export async function resolveLineItems(
  session: Session,
  items: ReadonlyArray<{ variantId: string; quantity: number }>,
  currencyCode: string,
): Promise<ResolvedLineItem[]> {
  const gids = items.map((item) => toVariantGid(item.variantId));

  // Duplicate ids in one submission would make quantities ambiguous — is it two
  // lines of 1, or one of 2? Rejecting is clearer than silently merging.
  if (new Set(gids).size !== gids.length) {
    throw new BadRequestError('The same variant appears more than once in this order');
  }

  const response = await adminGraphql<VariantsResponse>(session, VARIANTS_BY_IDS_QUERY, {
    variables: { ids: gids },
  });

  const byId = new Map<string, VariantNode>();
  for (const node of response.nodes) {
    if (node && node.id) byId.set(node.id, node);
  }

  const precision = currencyPrecision(currencyCode);
  const resolved: ResolvedLineItem[] = [];
  const problems: string[] = [];

  for (const item of items) {
    const gid = toVariantGid(item.variantId);
    const variant = byId.get(gid);

    if (!variant) {
      // A GID that resolves to nothing is either a deleted product or a
      // fabricated id. Both are refusals, and neither should say which.
      problems.push('One of the items in your order is no longer available.');
      continue;
    }

    if (variant.product.status !== 'ACTIVE') {
      problems.push(`${variant.product.title} is no longer available.`);
      continue;
    }

    if (!variant.availableForSale) {
      problems.push(`${variant.product.title} is sold out.`);
      continue;
    }

    // `CONTINUE` means the merchant sells past zero deliberately, so inventory
    // is only a constraint under `DENY`.
    if (
      variant.inventoryPolicy === 'DENY' &&
      variant.inventoryQuantity !== null &&
      variant.inventoryQuantity < item.quantity
    ) {
      problems.push(
        `Only ${Math.max(0, variant.inventoryQuantity)} left of ${variant.product.title}.`,
      );
      continue;
    }

    const unitPrice = new Prisma.Decimal(variant.price);
    const lineTotal = round(unitPrice.mul(item.quantity), precision);

    resolved.push({
      variantGid: variant.id,
      productGid: variant.product.id,
      title: variant.product.title,
      variantTitle: variant.title,
      sku: variant.sku,
      quantity: item.quantity,
      price: unitPrice.toFixed(precision),
      lineTotal: lineTotal.toFixed(precision),
      image:
        variant.image?.url ??
        variant.product.featuredMedia?.preview?.image?.url ??
        null,
    });
  }

  if (problems.length > 0) {
    throw new ValidationError('Some items could not be ordered', {
      // Deduplicated: five sold-out lines of the same product is one message.
      details: { lineItems: [...new Set(problems)] },
    });
  }

  return resolved;
}

/**
 * Applies the merchant's COD economics to resolved line items.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. subtotal from resolved prices
 *   2. shipping — waived when the subtotal reaches the free-shipping threshold
 *   3. COD fee — computed on the **subtotal**, not on subtotal plus shipping,
 *      so a merchant's percentage fee does not silently compound with delivery
 *   4. total
 *
 * The min/max order checks run against the subtotal for the same reason: a
 * merchant setting a £10 minimum means £10 of goods, not £10 including the fees
 * the app itself added.
 */
export function priceOrder(
  lineItems: readonly ResolvedLineItem[],
  settings: PricingSettings,
  currencyCode: string,
  bumpTotal: Prisma.Decimal = ZERO,
): PricedOrder {
  const precision = currencyPrecision(currencyCode);

  const subtotal = round(
    lineItems.reduce((sum, item) => sum.add(new Prisma.Decimal(item.lineTotal)), ZERO),
    precision,
  );

  if (settings.minOrderValue && subtotal.lessThan(settings.minOrderValue)) {
    throw new ValidationError(
      `Orders must total at least ${settings.minOrderValue.toFixed(precision)} ${currencyCode}.`,
      { details: { minOrderValue: settings.minOrderValue.toFixed(precision) } },
    );
  }

  if (settings.maxOrderValue && subtotal.greaterThan(settings.maxOrderValue)) {
    throw new ValidationError(
      `Cash on delivery is limited to ${settings.maxOrderValue.toFixed(precision)} ${currencyCode} per order.`,
      { details: { maxOrderValue: settings.maxOrderValue.toFixed(precision) } },
    );
  }

  let shippingFee = settings.shippingFee ?? ZERO;

  if (settings.freeShippingAbove && subtotal.greaterThanOrEqualTo(settings.freeShippingAbove)) {
    shippingFee = ZERO;
  }

  let codFee = ZERO;

  if (settings.codFeeEnabled && settings.codFeeAmount) {
    codFee = settings.codFeeIsPercent
      ? subtotal.mul(settings.codFeeAmount).div(100)
      : settings.codFeeAmount;
  }

  shippingFee = round(shippingFee, precision);
  codFee = round(codFee, precision);

  const bumps = round(bumpTotal, precision);

  /**
   * Add-ons join the total but not the subtotal, which is what keeps the
   * min/max order checks above meaning "this much of goods" — a shopper must
   * not be able to clear a merchant's minimum by ticking gift wrapping. For the
   * same reason a percentage COD fee is calculated before this line.
   */
  const total = round(subtotal.add(shippingFee).add(codFee).add(bumps), precision);

  return { lineItems, subtotal, shippingFee, codFee, bumpTotal: bumps, discount: ZERO, total };
}

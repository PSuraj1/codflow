import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { priceOrder, type PricingSettings, type ResolvedLineItem } from './pricing';

/**
 * COD pricing.
 *
 * The rule these tests exist to protect: no amount ever comes from the browser.
 * `priceOrder` recomputes every total from resolved line items and the
 * merchant's own settings, and the order of operations matters — a COD fee
 * computed on subtotal-plus-shipping would silently compound with delivery.
 */

function item(price: string, quantity: number): ResolvedLineItem {
  return {
    variantGid: `gid://shopify/ProductVariant/${price}`,
    productGid: 'gid://shopify/Product/1',
    title: 'Product',
    variantTitle: 'Default Title',
    sku: null,
    quantity,
    price,
    lineTotal: new Prisma.Decimal(price).mul(quantity).toFixed(2),
    image: null,
  };
}

function settings(overrides: Partial<PricingSettings> = {}): PricingSettings {
  return {
    codFeeEnabled: false,
    codFeeAmount: null,
    codFeeIsPercent: false,
    shippingFee: null,
    freeShippingAbove: null,
    minOrderValue: null,
    maxOrderValue: null,
    ...overrides,
  };
}

const d = (value: string | number) => new Prisma.Decimal(value);

describe('priceOrder', () => {
  it('sums line totals into the subtotal', () => {
    const result = priceOrder([item('400.00', 2), item('300.00', 1)], settings(), 'INR');
    expect(result.subtotal.toString()).toBe('1100');
    expect(result.total.toString()).toBe('1100');
  });

  it('adds a flat shipping fee', () => {
    const result = priceOrder([item('500.00', 1)], settings({ shippingFee: d(60) }), 'INR');
    expect(result.shippingFee.toString()).toBe('60');
    expect(result.total.toString()).toBe('560');
  });

  it('waives shipping at the free-shipping threshold', () => {
    const result = priceOrder(
      [item('1000.00', 1)],
      settings({ shippingFee: d(60), freeShippingAbove: d(999) }),
      'INR',
    );
    expect(result.shippingFee.toString()).toBe('0');
    expect(result.total.toString()).toBe('1000');
  });

  it('charges shipping just below the threshold', () => {
    const result = priceOrder(
      [item('998.00', 1)],
      settings({ shippingFee: d(60), freeShippingAbove: d(999) }),
      'INR',
    );
    expect(result.shippingFee.toString()).toBe('60');
  });

  it('applies a flat COD fee', () => {
    const result = priceOrder(
      [item('500.00', 1)],
      settings({ codFeeEnabled: true, codFeeAmount: d(49) }),
      'INR',
    );
    expect(result.codFee.toString()).toBe('49');
    expect(result.total.toString()).toBe('549');
  });

  /**
   * Computed on the subtotal, not on subtotal-plus-shipping. Otherwise a
   * percentage fee quietly compounds with delivery and the merchant charges
   * more than they configured.
   */
  it('computes a percentage COD fee on the subtotal alone', () => {
    const result = priceOrder(
      [item('1000.00', 1)],
      settings({
        codFeeEnabled: true,
        codFeeAmount: d(5),
        codFeeIsPercent: true,
        shippingFee: d(100),
      }),
      'INR',
    );

    // 5% of 1000, not 5% of 1100.
    expect(result.codFee.toString()).toBe('50');
    expect(result.total.toString()).toBe('1150');
  });

  it('ignores the COD fee when disabled', () => {
    const result = priceOrder(
      [item('500.00', 1)],
      settings({ codFeeEnabled: false, codFeeAmount: d(49) }),
      'INR',
    );
    expect(result.codFee.toString()).toBe('0');
  });

  describe('order value limits', () => {
    /**
     * Checked against the subtotal, so a merchant's "£10 minimum" means £10 of
     * goods rather than £10 including the fees the app itself added.
     */
    it('rejects an order below the minimum', () => {
      expect(() =>
        priceOrder([item('100.00', 1)], settings({ minOrderValue: d(199) }), 'INR'),
      ).toThrow(/at least/i);
    });

    it('rejects an order above the maximum', () => {
      expect(() =>
        priceOrder([item('30000.00', 1)], settings({ maxOrderValue: d(25000) }), 'INR'),
      ).toThrow(/limited to/i);
    });

    it('accepts an order exactly at the minimum', () => {
      expect(() =>
        priceOrder([item('199.00', 1)], settings({ minOrderValue: d(199) }), 'INR'),
      ).not.toThrow();
    });

    it('measures the limit against the subtotal, not the total', () => {
      // Subtotal 199 passes even though fees push the total well above it.
      expect(() =>
        priceOrder(
          [item('199.00', 1)],
          settings({ minOrderValue: d(199), shippingFee: d(60), codFeeEnabled: true, codFeeAmount: d(49) }),
          'INR',
        ),
      ).not.toThrow();
    });
  });

  describe('currency precision', () => {
    /**
     * Scaling by 100 — the usual "work in cents" shortcut — mis-prices entire
     * markets. JPY has no decimal places and KWD has three.
     */
    it('rounds a zero-decimal currency to whole units', () => {
      const result = priceOrder(
        [item('1000', 1)],
        settings({ codFeeEnabled: true, codFeeAmount: d(3.5), codFeeIsPercent: true }),
        'JPY',
      );
      // 3.5% of 1000 is 35 exactly; the point is it carries no fractional yen.
      expect(result.codFee.toString()).toBe('35');
      expect(result.total.toString()).toBe('1035');
    });

    it('keeps three decimal places for a three-decimal currency', () => {
      const result = priceOrder(
        [item('10.000', 1)],
        settings({ codFeeEnabled: true, codFeeAmount: d(1.5), codFeeIsPercent: true }),
        'KWD',
      );
      expect(result.codFee.toString()).toBe('0.15');
    });

    it('rounds half up at two decimal places by default', () => {
      const result = priceOrder(
        [item('10.00', 1)],
        settings({ codFeeEnabled: true, codFeeAmount: d(3.333), codFeeIsPercent: true }),
        'USD',
      );
      // 0.3333 -> 0.33
      expect(result.codFee.toString()).toBe('0.33');
    });
  });

  /**
   * Floating point cannot represent most decimal fractions exactly, and on a
   * COD order those fractions are what a courier collects in cash.
   */
  it('does not accumulate floating-point error', () => {
    const result = priceOrder(
      [item('0.10', 1), item('0.20', 1)],
      settings(),
      'USD',
    );
    expect(result.subtotal.toString()).toBe('0.3');
  });

  it('returns zero discount until discounts are implemented', () => {
    expect(priceOrder([item('100.00', 1)], settings(), 'USD').discount.toString()).toBe('0');
  });
});

/**
 * Tick-box add-ons.
 *
 * They join the *total* but never the *subtotal*, and that distinction is the
 * whole design: the min/max order checks and a percentage COD fee both read the
 * subtotal, so a shopper must not be able to clear a merchant's minimum — or
 * inflate their own COD fee — by ticking gift wrapping.
 */
describe('order bumps', () => {
  it('adds the bump total to the order total', () => {
    const result = priceOrder([item('500.00', 1)], settings(), 'INR', d(99));

    expect(result.bumpTotal.toFixed(2)).toBe('99.00');
    expect(result.subtotal.toFixed(2)).toBe('500.00');
    expect(result.total.toFixed(2)).toBe('599.00');
  });

  it('defaults to nothing when no add-on was accepted', () => {
    const result = priceOrder([item('500.00', 1)], settings(), 'INR');

    expect(result.bumpTotal.toFixed(2)).toBe('0.00');
    expect(result.total.toFixed(2)).toBe('500.00');
  });

  /** Ticking an extra must not buy a way past the merchant's floor. */
  it('does not count toward the minimum order value', () => {
    expect(() =>
      priceOrder([item('100.00', 1)], settings({ minOrderValue: d(200) }), 'INR', d(150)),
    ).toThrow(/at least/);
  });

  it('does not count toward the maximum order value', () => {
    expect(() =>
      priceOrder([item('100.00', 1)], settings({ maxOrderValue: d(200) }), 'INR', d(150)),
    ).not.toThrow();
  });

  /** A percentage fee is a percentage of the goods, not of the goods plus extras. */
  it('is excluded from a percentage COD fee', () => {
    const result = priceOrder(
      [item('1000.00', 1)],
      settings({ codFeeEnabled: true, codFeeAmount: d(10), codFeeIsPercent: true }),
      'INR',
      d(500),
    );

    expect(result.codFee.toFixed(2)).toBe('100.00');
    expect(result.total.toFixed(2)).toBe('1600.00');
  });

  it('does not earn free delivery on its own', () => {
    const result = priceOrder(
      [item('400.00', 1)],
      settings({ shippingFee: d(60), freeShippingAbove: d(500) }),
      'INR',
      d(200),
    );

    // Subtotal is 400, below the 500 threshold, so delivery still applies.
    expect(result.shippingFee.toFixed(2)).toBe('60.00');
    expect(result.total.toFixed(2)).toBe('660.00');
  });
});

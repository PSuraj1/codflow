import { describe, expect, it } from 'vitest';
import { UpdateFeesSchema } from './dto';

/**
 * COD fee and delivery input validation.
 *
 * Amounts are decimal *strings* throughout, and that is the point of most of
 * this file. Every value here is added to an order total the server resolved
 * from Shopify, so accepting a number would put a float in the middle of money
 * arithmetic and lose paise on the way.
 *
 * The other half is null. Clearing a charge is a real edit — it means "charge
 * nothing" — and it has to be distinguishable from omitting the field, which
 * means "leave it alone".
 */

describe('amounts', () => {
  it.each(['0', '49', '49.5', '49.50', '1000', '9999999999'])('accepts %s', (shippingFee) => {
    expect(UpdateFeesSchema.safeParse({ shippingFee }).success).toBe(true);
  });

  it.each([
    ['a number', 49],
    ['three decimal places', '49.501'],
    ['a negative', '-49'],
    ['a currency symbol', '₹49'],
    ['a thousands separator', '1,000'],
    ['whitespace', ' 49 '],
    ['empty', ''],
    ['not a number', 'free'],
  ])('rejects %s', (_label, shippingFee) => {
    expect(UpdateFeesSchema.safeParse({ shippingFee }).success).toBe(false);
  });

  /** Null clears the charge. Undefined leaves it untouched. */
  it('accepts null to clear a charge', () => {
    expect(UpdateFeesSchema.safeParse({ shippingFee: null }).success).toBe(true);
    expect(UpdateFeesSchema.safeParse({ freeShippingAbove: null }).success).toBe(true);
    expect(UpdateFeesSchema.safeParse({ codFeeAmount: null }).success).toBe(true);
  });

  it('accepts an empty patch', () => {
    expect(UpdateFeesSchema.safeParse({}).success).toBe(true);
  });
});

describe('toggles', () => {
  it('accepts the booleans', () => {
    const parsed = UpdateFeesSchema.safeParse({ codFeeEnabled: false, codFeeIsPercent: true });
    expect(parsed.success).toBe(true);
  });

  it.each(['yes', 1, 'true'])('rejects %s as a boolean', (codFeeEnabled) => {
    expect(UpdateFeesSchema.safeParse({ codFeeEnabled }).success).toBe(false);
  });
});

/**
 * The order-value bounds are deliberately absent.
 *
 * They are money, but they decide *whether* COD is offered rather than what it
 * costs, so they belong to `UpdateVisibilitySchema`. Accepting them here too
 * would give a merchant two screens writing one column, with no way to tell
 * which of them won.
 */
describe('scope', () => {
  it.each(['minOrderValue', 'maxOrderValue'])('does not carry %s', (key) => {
    const parsed = UpdateFeesSchema.safeParse({ [key]: '499' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && key in parsed.data).toBe(false);
  });
});

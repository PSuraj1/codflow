import { describe, expect, it } from 'vitest';
import { CreateOrderBumpSchema, UpdateOrderBumpSchema } from './dto';

/**
 * Order bump input.
 *
 * The price is the field that matters. It is added to an order total the server
 * resolved from Shopify, so it is a decimal *string* throughout — a float would
 * lose paise between here and the draft order Shopify creates.
 */

const bump = (over: Record<string, unknown> = {}) => ({ title: 'Gift wrap', price: '49', ...over });

describe('price', () => {
  it.each(['0', '49', '49.5', '49.50', '1000'])('accepts %s', (price) => {
    expect(CreateOrderBumpSchema.safeParse(bump({ price })).success).toBe(true);
  });

  it.each([
    ['a number', 49],
    ['three decimals', '49.501'],
    ['a negative', '-49'],
    ['a currency symbol', '₹49'],
    ['a separator', '1,000'],
    ['empty', ''],
  ])('rejects %s', (_label, price) => {
    expect(CreateOrderBumpSchema.safeParse(bump({ price })).success).toBe(false);
  });

  it('is required on create', () => {
    expect(CreateOrderBumpSchema.safeParse({ title: 'Gift wrap' }).success).toBe(false);
  });

  /** A merchant editing only the title must not have to resend the price. */
  it('is optional on update', () => {
    expect(UpdateOrderBumpSchema.safeParse({ title: 'Renamed' }).success).toBe(true);
  });
});

describe('title', () => {
  it('is required and bounded', () => {
    expect(CreateOrderBumpSchema.safeParse({ price: '49' }).success).toBe(false);
    expect(CreateOrderBumpSchema.safeParse(bump({ title: '' })).success).toBe(false);
    expect(CreateOrderBumpSchema.safeParse(bump({ title: 'a'.repeat(81) })).success).toBe(false);
  });
});

describe('defaults', () => {
  it('is shown unless the merchant says otherwise', () => {
    const parsed = CreateOrderBumpSchema.safeParse(bump());

    expect(parsed.success && parsed.data.isEnabled).toBe(true);
  });

  /**
   * App Store requirement 1.1.9: an app "can't automatically add or pre-select
   * optional charges to a buyer's cart that increase the total checkout price."
   *
   * A bump used to carry `defaultChecked`, which did exactly that. The schema
   * strips unknown keys, so a stored payload from before the removal — or a
   * client still sending it — cannot bring the behaviour back.
   */
  it('refuses to carry a pre-tick flag at all', () => {
    const parsed = CreateOrderBumpSchema.safeParse({ ...bump(), defaultChecked: true });

    expect(parsed.success).toBe(true);
    expect(parsed.success && 'defaultChecked' in parsed.data).toBe(false);
  });
});

/** Anything not named here is stripped, so a payload cannot reach a column. */
describe('unknown fields', () => {
  it.each(['id', 'shopId', 'createdAt'])('strips %s', (key) => {
    const parsed = CreateOrderBumpSchema.safeParse(bump({ [key]: 'x' }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && key in parsed.data).toBe(false);
  });
});

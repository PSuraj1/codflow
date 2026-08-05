import { Prisma, type CodOrder } from '@prisma/client';
import type { SheetColumnMapping } from '@codflow/shared';
import { describe, expect, it } from 'vitest';
import { buildHeaderRow, buildRows } from './rowBuilder';

/**
 * Google Sheets row construction.
 *
 * Where the merchant's two layout checkboxes actually take effect. The
 * behaviour worth protecting is the one nobody would think to check: in
 * one-row-per-line-item mode, order-level money appears on the first row only,
 * so a SUM over the total column reports real revenue rather than a multiple of
 * it.
 */

function order(overrides: Partial<CodOrder> = {}): CodOrder {
  return {
    reference: 'CF-K3M9XQ2A',
    status: 'CONFIRMED',
    createdAt: new Date('2026-07-28T09:15:30Z'),
    shopifyOrderNumber: '#1042',
    orderNotes: 'Leave at gate',
    tags: ['COD'],
    firstName: 'Asha',
    lastName: 'Patel',
    phone: '0712345678',
    phoneE164: '+919712345678',
    email: 'asha@example.com',
    address1: '12 High St',
    address2: null,
    city: 'Pune',
    province: 'MH',
    postalCode: '011001',
    country: 'India',
    countryCode: 'IN',
    subtotal: new Prisma.Decimal('1100.00'),
    shippingFee: new Prisma.Decimal('60.00'),
    codFee: new Prisma.Decimal('49.00'),
    discount: new Prisma.Decimal('0.00'),
    total: new Prisma.Decimal('1209.00'),
    currency: 'INR',
    discountCode: null,
    riskScore: 12,
    riskLevel: 'LOW',
    otpVerified: true,
    ipAddress: '203.0.113.7',
    utmSource: 'meta',
    utmMedium: null,
    utmCampaign: null,
    referrer: null,
    landingPage: null,
    customFields: { landmark: 'Near the temple' },
    lineItems: [
      { title: 'T-shirt', variantTitle: 'Large', sku: 'TS-L', quantity: 2, price: '400.00', lineTotal: '800.00' },
      { title: 'Cap', variantTitle: 'Default Title', sku: 'CP', quantity: 1, price: '300.00', lineTotal: '300.00' },
    ],
    ...overrides,
  } as unknown as CodOrder;
}

const mapping: SheetColumnMapping[] = [
  { column: 'A', header: 'Date & Time', source: 'createdAt' },
  { column: 'B', header: 'Order ID', source: 'reference' },
  { column: 'C', header: 'Product Name', source: 'lineItem.title' },
  { column: 'D', header: 'Variant', source: 'lineItem.variantTitle' },
  { column: 'E', header: 'Qty', source: 'lineItem.quantity' },
  { column: 'F', header: 'Full Name', source: 'fullName' },
  { column: 'G', header: 'Phone', source: 'phone' },
  { column: 'H', header: 'PIN Code', source: 'postalCode' },
  { column: 'I', header: 'Total', source: 'total' },
  { column: 'J', header: 'Landmark', source: 'customFields.landmark' },
];

const single = { mapping, singleRowPerOrder: true, timeZone: 'Asia/Kolkata' };
const multi = { mapping, singleRowPerOrder: false, timeZone: 'UTC' };

describe('buildHeaderRow', () => {
  it('uses the merchant headers in column order', () => {
    expect(buildHeaderRow(mapping)[0]).toBe('Date & Time');
    expect(buildHeaderRow(mapping)).toHaveLength(mapping.length);
  });
});

describe('single row per order', () => {
  it('produces exactly one row', () => {
    expect(buildRows(order(), single)).toHaveLength(1);
  });

  it('joins line-item values into one cell', () => {
    expect(buildRows(order(), single)[0]?.[2]).toBe('T-shirt, Cap');
    expect(buildRows(order(), single)[0]?.[4]).toBe('2, 1');
  });

  it('suppresses Shopify’s Default Title sentinel', () => {
    // Positions stay aligned so the merchant can tell which product has no
    // variant, but a trailing separator would read as truncated.
    expect(buildRows(order(), single)[0]?.[3]).toBe('Large');
  });

  it('keeps an empty middle value as an empty slot', () => {
    const threeItems = order({
      lineItems: [
        { title: 'A', variantTitle: 'Small', sku: null, quantity: 1, price: '1', lineTotal: '1' },
        { title: 'B', variantTitle: 'Default Title', sku: null, quantity: 1, price: '1', lineTotal: '1' },
        { title: 'C', variantTitle: 'Large', sku: null, quantity: 1, price: '1', lineTotal: '1' },
      ],
    } as Partial<CodOrder>);

    expect(buildRows(threeItems, single)[0]?.[3]).toBe('Small, , Large');
  });

  it('renders the timestamp in the shop timezone', () => {
    // 09:15:30 UTC is 14:45:30 in Asia/Kolkata.
    expect(buildRows(order(), single)[0]?.[0]).toBe('2026-07-28 14:45:30');
  });

  it('resolves a custom field', () => {
    expect(buildRows(order(), single)[0]?.[9]).toBe('Near the temple');
  });
});

describe('one row per line item', () => {
  it('produces one row per item', () => {
    expect(buildRows(order(), multi)).toHaveLength(2);
  });

  it('splits products across rows', () => {
    const rows = buildRows(order(), multi);
    expect(rows[0]?.[2]).toBe('T-shirt');
    expect(rows[1]?.[2]).toBe('Cap');
  });

  /**
   * The rule that makes a SUM correct. Repeating the total on every row would
   * report 2418 for a 1209 order.
   */
  it('writes order money on the first row only', () => {
    const rows = buildRows(order(), multi);
    expect(rows[0]?.[8]).toBe('1209');
    expect(rows[1]?.[8]).toBe('');
  });

  it('still repeats non-money order values on every row', () => {
    // The customer's name has to be on each row or the sheet is unreadable.
    const rows = buildRows(order(), multi);
    expect(rows[1]?.[5]).toBe('Asha Patel');
  });

  it('collapses to one row for a single-item order', () => {
    const oneItem = order({
      lineItems: [
        { title: 'Solo', variantTitle: 'Default Title', sku: null, quantity: 1, price: '1', lineTotal: '1' },
      ],
    } as Partial<CodOrder>);

    const rows = buildRows(oneItem, multi);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[2]).toBe('Solo');
  });
});

describe('text coercion', () => {
  /**
   * Without a leading apostrophe Sheets strips the leading zero from a phone
   * number and parses `+91…` as a formula. On a COD order that is the
   * difference between a delivery and a return.
   */
  it('forces phone numbers to text', () => {
    expect(buildRows(order(), single)[0]?.[6]).toBe("'0712345678");
  });

  it('forces postal codes to text', () => {
    expect(buildRows(order(), single)[0]?.[7]).toBe("'011001");
  });

  it('leaves an empty phone blank rather than a bare apostrophe', () => {
    const blank = order({ phone: '' } as Partial<CodOrder>);
    expect(buildRows(blank, single)[0]?.[6]).toBe('');
  });
});

describe('resilience', () => {
  it('still emits a row for an order with no line items', () => {
    // The customer is still expecting a delivery.
    const empty = order({ lineItems: [] } as Partial<CodOrder>);
    const rows = buildRows(empty, single);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[2]).toBe('');
  });

  it('returns a blank cell for an unknown source rather than throwing', () => {
    // A mapping kept after a field was retired must not strand every order.
    const rows = buildRows(order(), {
      mapping: [{ column: 'A', header: 'X', source: 'retiredField' }],
      singleRowPerOrder: true,
      timeZone: 'UTC',
    });

    expect(rows[0]?.[0]).toBe('');
  });

  it('returns a blank cell for a missing custom field', () => {
    const rows = buildRows(order(), {
      mapping: [{ column: 'A', header: 'X', source: 'customFields.absent' }],
      singleRowPerOrder: true,
      timeZone: 'UTC',
    });

    expect(rows[0]?.[0]).toBe('');
  });

  it('falls back to UTC for an invalid timezone', () => {
    const rows = buildRows(order(), {
      mapping: [{ column: 'A', header: 'D', source: 'createdAt' }],
      singleRowPerOrder: true,
      timeZone: 'Not/AZone',
    });

    expect(rows[0]?.[0]).toBe('2026-07-28 09:15:30');
  });

  it('tolerates a malformed lineItems column', () => {
    const broken = order({ lineItems: 'not-an-array' } as unknown as Partial<CodOrder>);
    expect(() => buildRows(broken, single)).not.toThrow();
  });
});

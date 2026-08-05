import type { CodOrder } from '@prisma/client';
import {
  CUSTOM_FIELD_PREFIX,
  isLineItemSource,
  type SheetColumnMapping,
} from '@codflow/shared';
import type { ResolvedLineItem } from '../orders/pricing';

/**
 * Turns a COD order into spreadsheet rows.
 *
 * This is where the merchant's two layout choices actually take effect, and
 * they interact in a way worth being explicit about:
 *
 *  - **One row per order** (the default). Line-item values are joined into a
 *    single cell — `"T-shirt, Cap"` — so a three-item order reads as one order.
 *    A merchant using the sheet as a fulfilment list wants this; without it a
 *    three-item order looks like three orders and their daily count is wrong.
 *
 *  - **One row per line item.** Every row repeats the customer's details and
 *    carries one product. A merchant pivoting by product needs this, and the
 *    repetition is the point rather than a flaw.
 *
 * The order-level totals are the trap in the second mode. Writing the order
 * total onto every row would make a `SUM` over that column report three times
 * the revenue. So order-scoped monetary values appear on the **first row only**
 * and are left blank on continuation rows — which sums correctly and reads
 * correctly.
 */

/** Values are strings: Sheets receives everything as text and interprets it. */
export type SheetRow = string[];

/** Separator for joined line-item values in single-row mode. */
const JOIN_SEPARATOR = ', ';

/** Money columns that must not repeat across a multi-row order. */
const ORDER_MONEY_SOURCES = new Set([
  'subtotal',
  'shippingFee',
  'codFee',
  'discount',
  'total',
]);

function safeLineItems(order: CodOrder): ResolvedLineItem[] {
  return Array.isArray(order.lineItems)
    ? (order.lineItems as unknown as ResolvedLineItem[])
    : [];
}

function customFields(order: CodOrder): Record<string, unknown> {
  return typeof order.customFields === 'object' && order.customFields !== null
    ? (order.customFields as Record<string, unknown>)
    : {};
}

/**
 * Formats a timestamp for a spreadsheet.
 *
 * `YYYY-MM-DD HH:mm:ss` rather than ISO 8601: Sheets parses this into a real
 * date value under `USER_ENTERED`, so the merchant can sort and filter by it.
 * An ISO string with a `T` and a `Z` is stored as text, and a text column
 * sorts `2026-01-10` before `2026-01-09T23:00Z` in ways that look like bugs.
 *
 * Rendered in the shop's timezone, because the merchant reconciles this sheet
 * against their own working day, not against UTC.
 */
function formatTimestamp(value: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(value);

    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';

    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    // An invalid IANA zone stored on the shop should not lose the timestamp.
    return value.toISOString().replace('T', ' ').slice(0, 19);
  }
}

function joinAddress(order: CodOrder): string {
  return [order.address1, order.address2, order.city, order.province, order.postalCode, order.country]
    .filter((part) => part && String(part).trim().length > 0)
    .join(', ');
}

/** Resolves one order-scoped source to its cell value. */
function orderValue(order: CodOrder, source: string, timeZone: string): string {
  if (source.startsWith(CUSTOM_FIELD_PREFIX)) {
    const key = source.slice(CUSTOM_FIELD_PREFIX.length);
    const value = customFields(order)[key];

    if (value === null || value === undefined) return '';
    return Array.isArray(value) ? value.join(JOIN_SEPARATOR) : String(value);
  }

  switch (source) {
    case 'createdAt':
      return formatTimestamp(order.createdAt, timeZone);
    case 'reference':
      return order.reference;
    case 'shopifyOrderNumber':
      return order.shopifyOrderNumber ?? '';
    case 'status':
      return order.status;
    case 'orderNotes':
      return order.orderNotes ?? '';
    case 'tags':
      return order.tags.join(JOIN_SEPARATOR);

    case 'itemCount':
      return String(safeLineItems(order).reduce((sum, item) => sum + item.quantity, 0));

    case 'fullName':
      return [order.firstName, order.lastName].filter(Boolean).join(' ');
    case 'firstName':
      return order.firstName ?? '';
    case 'lastName':
      return order.lastName ?? '';
    case 'phone':
      // Leading apostrophe forces Sheets to keep it as text. Without it a
      // number like `0712345678` loses its leading zero and `+91…` is parsed
      // as a formula — both make the number undialable, which for a COD order
      // is the difference between a delivery and a return.
      return order.phone ? `'${order.phone}` : '';
    case 'phoneE164':
      return order.phoneE164 ? `'${order.phoneE164}` : '';
    case 'email':
      return order.email ?? '';

    case 'address1':
      return order.address1 ?? '';
    case 'address2':
      return order.address2 ?? '';
    case 'fullAddress':
      return joinAddress(order);
    case 'city':
      return order.city ?? '';
    case 'province':
      return order.province ?? '';
    case 'postalCode':
      // Same reasoning as the phone number: many postal codes are
      // zero-prefixed, and Sheets would strip it.
      return order.postalCode ? `'${order.postalCode}` : '';
    case 'country':
      return order.country ?? '';
    case 'countryCode':
      return order.countryCode ?? '';

    case 'subtotal':
      return order.subtotal.toString();
    case 'shippingFee':
      return order.shippingFee.toString();
    case 'codFee':
      return order.codFee.toString();
    case 'discount':
      return order.discount.toString();
    case 'discountCode':
      return order.discountCode ?? '';
    case 'total':
      return order.total.toString();
    case 'currency':
      return order.currency;

    case 'riskScore':
      return String(order.riskScore);
    case 'riskLevel':
      return order.riskLevel;
    case 'otpVerified':
      return order.otpVerified ? 'Yes' : 'No';
    case 'ipAddress':
      return order.ipAddress ?? '';

    case 'utmSource':
      return order.utmSource ?? '';
    case 'utmMedium':
      return order.utmMedium ?? '';
    case 'utmCampaign':
      return order.utmCampaign ?? '';
    case 'referrer':
      return order.referrer ?? '';
    case 'landingPage':
      return order.landingPage ?? '';

    default:
      // A source key from a newer build, or one the merchant's mapping kept
      // after a field was retired. A blank cell is the right answer — failing
      // the whole sync over one unknown column would strand every order.
      return '';
  }
}

/** Resolves one line-item-scoped source. */
function lineItemValue(item: ResolvedLineItem, source: string): string {
  switch (source) {
    case 'lineItem.title':
      return item.title;
    case 'lineItem.variantTitle':
      // Shopify uses this sentinel for products with no real variants; showing
      // it in a merchant's sheet is noise.
      return item.variantTitle === 'Default Title' ? '' : item.variantTitle;
    case 'lineItem.sku':
      return item.sku ?? '';
    case 'lineItem.quantity':
      return String(item.quantity);
    case 'lineItem.price':
      return item.price;
    case 'lineItem.lineTotal':
      return item.lineTotal;
    default:
      return '';
  }
}

export interface BuildRowsOptions {
  readonly mapping: readonly SheetColumnMapping[];
  readonly singleRowPerOrder: boolean;
  /** IANA zone from the shop, so timestamps read in the merchant's own day. */
  readonly timeZone: string;
}

/**
 * Builds every row for one order.
 *
 * Always returns at least one row: an order with no line items — possible if a
 * merchant deleted the product afterwards — still belongs in the sheet, because
 * the customer is still expecting a delivery.
 */
export function buildRows(order: CodOrder, options: BuildRowsOptions): SheetRow[] {
  const items = safeLineItems(order);
  const { mapping, singleRowPerOrder, timeZone } = options;

  if (singleRowPerOrder || items.length <= 1) {
    const item = items[0];

    return [
      mapping.map((column) => {
        if (!isLineItemSource(column.source)) {
          return orderValue(order, column.source, timeZone);
        }

        if (items.length === 0) return '';
        if (items.length === 1 && item) return lineItemValue(item, column.source);

        // Several items collapsed into one cell. Positions are kept aligned
        // across columns — `"T-shirt, Cap"` beside `"Large, "` tells the
        // merchant the cap has no variant — so an empty middle value stays as
        // an empty slot. Only a trailing run is trimmed, since a cell ending in
        // ", " reads as truncated rather than as meaningful.
        return items
          .map((entry) => lineItemValue(entry, column.source))
          .join(JOIN_SEPARATOR)
          .replace(/(?:,\s*)+$/, '');
      }),
    ];
  }

  // One row per line item. Order-scoped money appears on the first row only, so
  // a SUM over the total column is the real revenue rather than a multiple of
  // it.
  return items.map((item, index) =>
    mapping.map((column) => {
      if (isLineItemSource(column.source)) {
        return lineItemValue(item, column.source);
      }

      if (index > 0 && ORDER_MONEY_SOURCES.has(column.source)) {
        return '';
      }

      return orderValue(order, column.source, timeZone);
    }),
  );
}

/** The header row for a mapping. */
export function buildHeaderRow(mapping: readonly SheetColumnMapping[]): SheetRow {
  return mapping.map((column) => column.header);
}

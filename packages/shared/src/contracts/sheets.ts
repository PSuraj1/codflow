/**
 * Google Sheets contracts.
 *
 * The mapping is column-first, not field-first: the merchant sees spreadsheet
 * columns A, B, C… and chooses what goes in each. That is the direction they
 * think in — they are looking at their sheet — and it makes the mapping
 * positional, so reordering columns in the UI reorders them in the sheet.
 */

/**
 * A value that can be written into a column.
 *
 * `group` drives the optgroup headings in the dropdown; `scope` decides how a
 * multi-item order is handled. That second one carries real weight — see
 * `SheetRowLayout` below.
 */
export interface SheetFieldSource {
  /** Stable key persisted in `columnMapping`. Never change one in place. */
  readonly key: string;
  readonly label: string;
  readonly group: SheetFieldGroup;
  /**
   * `order` — one value per order (reference, phone, total).
   * `lineItem` — one value per line item (product name, SKU, unit price).
   *
   * The distinction is what makes "single row per order" meaningful: an
   * order-scoped value is identical on every row, while a line-item-scoped one
   * has to be either joined into a list or split across rows.
   */
  readonly scope: 'order' | 'lineItem';
  /** Default spreadsheet header text. The merchant can override it. */
  readonly defaultHeader: string;
}

export const SheetFieldGroup = {
  ORDER: 'Order',
  CUSTOMER: 'Customer',
  ADDRESS: 'Delivery address',
  PRODUCT: 'Product',
  TOTALS: 'Totals',
  RISK: 'Risk',
  ATTRIBUTION: 'Marketing',
  CUSTOM: 'Custom fields',
} as const;

export type SheetFieldGroup = (typeof SheetFieldGroup)[keyof typeof SheetFieldGroup];

/**
 * Everything CODkar can write into a sheet.
 *
 * Ordered roughly as a merchant builds a sheet left to right — when it
 * happened, which order, what was bought, who bought it, where it goes, what it
 * costs. The default mapping below follows the same order.
 */
export const SHEET_FIELD_SOURCES: readonly SheetFieldSource[] = [
  // ---- Order
  { key: 'createdAt', label: 'Date & time', group: SheetFieldGroup.ORDER, scope: 'order', defaultHeader: 'Date & Time' },
  { key: 'reference', label: 'Order ID', group: SheetFieldGroup.ORDER, scope: 'order', defaultHeader: 'Order ID' },
  { key: 'shopifyOrderNumber', label: 'Shopify order number', group: SheetFieldGroup.ORDER, scope: 'order', defaultHeader: 'Shopify Order' },
  { key: 'status', label: 'Status', group: SheetFieldGroup.ORDER, scope: 'order', defaultHeader: 'Status' },
  { key: 'orderNotes', label: 'Order notes', group: SheetFieldGroup.ORDER, scope: 'order', defaultHeader: 'Notes' },
  { key: 'tags', label: 'Tags', group: SheetFieldGroup.ORDER, scope: 'order', defaultHeader: 'Tags' },

  // ---- Product
  { key: 'lineItem.title', label: 'Product name', group: SheetFieldGroup.PRODUCT, scope: 'lineItem', defaultHeader: 'Product Name' },
  { key: 'lineItem.variantTitle', label: 'Variant', group: SheetFieldGroup.PRODUCT, scope: 'lineItem', defaultHeader: 'Variant' },
  { key: 'lineItem.sku', label: 'SKU', group: SheetFieldGroup.PRODUCT, scope: 'lineItem', defaultHeader: 'SKU' },
  { key: 'lineItem.quantity', label: 'Quantity', group: SheetFieldGroup.PRODUCT, scope: 'lineItem', defaultHeader: 'Qty' },
  { key: 'lineItem.price', label: 'Product price', group: SheetFieldGroup.PRODUCT, scope: 'lineItem', defaultHeader: 'Product Price' },
  { key: 'lineItem.lineTotal', label: 'Line total', group: SheetFieldGroup.PRODUCT, scope: 'lineItem', defaultHeader: 'Line Total' },
  { key: 'itemCount', label: 'Total items', group: SheetFieldGroup.PRODUCT, scope: 'order', defaultHeader: 'Items' },

  // ---- Customer
  { key: 'fullName', label: 'Full name', group: SheetFieldGroup.CUSTOMER, scope: 'order', defaultHeader: 'Full Name' },
  { key: 'firstName', label: 'First name', group: SheetFieldGroup.CUSTOMER, scope: 'order', defaultHeader: 'First Name' },
  { key: 'lastName', label: 'Last name', group: SheetFieldGroup.CUSTOMER, scope: 'order', defaultHeader: 'Last Name' },
  { key: 'phone', label: 'Phone', group: SheetFieldGroup.CUSTOMER, scope: 'order', defaultHeader: 'Phone' },
  { key: 'phoneE164', label: 'Phone (international)', group: SheetFieldGroup.CUSTOMER, scope: 'order', defaultHeader: 'Phone (E.164)' },
  { key: 'email', label: 'Email', group: SheetFieldGroup.CUSTOMER, scope: 'order', defaultHeader: 'Email' },

  // ---- Address
  { key: 'address1', label: 'Address', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'Address' },
  { key: 'address2', label: 'Address line 2', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'Address 2' },
  { key: 'fullAddress', label: 'Full address (one cell)', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'Full Address' },
  { key: 'city', label: 'City', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'City' },
  { key: 'province', label: 'State / province', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'State' },
  { key: 'postalCode', label: 'PIN / postal code', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'PIN Code' },
  { key: 'country', label: 'Country', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'Country' },
  { key: 'countryCode', label: 'Country code', group: SheetFieldGroup.ADDRESS, scope: 'order', defaultHeader: 'Country Code' },

  // ---- Totals
  { key: 'subtotal', label: 'Subtotal', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'Subtotal' },
  { key: 'shippingFee', label: 'Delivery fee', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'Delivery' },
  { key: 'codFee', label: 'COD fee', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'COD Fee' },
  { key: 'discount', label: 'Discount', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'Discount' },
  { key: 'discountCode', label: 'Discount code', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'Discount Code' },
  { key: 'total', label: 'Total', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'Total' },
  { key: 'currency', label: 'Currency', group: SheetFieldGroup.TOTALS, scope: 'order', defaultHeader: 'Currency' },

  // ---- Risk
  { key: 'riskScore', label: 'Risk score', group: SheetFieldGroup.RISK, scope: 'order', defaultHeader: 'Risk Score' },
  { key: 'riskLevel', label: 'Risk level', group: SheetFieldGroup.RISK, scope: 'order', defaultHeader: 'Risk' },
  { key: 'otpVerified', label: 'Phone verified', group: SheetFieldGroup.RISK, scope: 'order', defaultHeader: 'Verified' },
  { key: 'ipAddress', label: 'IP address', group: SheetFieldGroup.RISK, scope: 'order', defaultHeader: 'IP' },

  // ---- Attribution
  { key: 'utmSource', label: 'UTM source', group: SheetFieldGroup.ATTRIBUTION, scope: 'order', defaultHeader: 'UTM Source' },
  { key: 'utmMedium', label: 'UTM medium', group: SheetFieldGroup.ATTRIBUTION, scope: 'order', defaultHeader: 'UTM Medium' },
  { key: 'utmCampaign', label: 'UTM campaign', group: SheetFieldGroup.ATTRIBUTION, scope: 'order', defaultHeader: 'UTM Campaign' },
  { key: 'referrer', label: 'Referrer', group: SheetFieldGroup.ATTRIBUTION, scope: 'order', defaultHeader: 'Referrer' },
  { key: 'landingPage', label: 'Landing page', group: SheetFieldGroup.ATTRIBUTION, scope: 'order', defaultHeader: 'Landing Page' },
];

const SOURCE_BY_KEY = new Map(SHEET_FIELD_SOURCES.map((source) => [source.key, source]));

/**
 * Resolves a mapping key to its source definition.
 *
 * Returns undefined for `customFields.*`, which are merchant-defined and
 * therefore not in the static catalogue — the caller handles those by prefix.
 */
export function sheetFieldSource(key: string): SheetFieldSource | undefined {
  return SOURCE_BY_KEY.get(key);
}

/** Prefix marking a column bound to a form field the merchant created. */
export const CUSTOM_FIELD_PREFIX = 'customFields.' as const;

export function isCustomFieldSource(key: string): boolean {
  return key.startsWith(CUSTOM_FIELD_PREFIX);
}

/** True when a column's value varies per line item rather than per order. */
export function isLineItemSource(key: string): boolean {
  return SOURCE_BY_KEY.get(key)?.scope === 'lineItem';
}

/** One column of the merchant's mapping. */
export interface SheetColumnMapping {
  /** Spreadsheet column letter — A, B, … AA. Derived from position on save. */
  readonly column: string;
  /** Header text written into the header row. */
  readonly header: string;
  /** A key from {@link SHEET_FIELD_SOURCES}, or `customFields.<formFieldKey>`. */
  readonly source: string;
}

/**
 * The default mapping a merchant starts with.
 *
 * Matches the order a COD merchant reads a fulfilment sheet in: when, which
 * order, what, who, where, how much. They can rearrange it, but a sensible
 * starting point is what stops the mapping step from being a blank grid.
 */
export const DEFAULT_COLUMN_MAPPING: readonly SheetColumnMapping[] = [
  { column: 'A', header: 'Date & Time', source: 'createdAt' },
  { column: 'B', header: 'Order ID', source: 'reference' },
  { column: 'C', header: 'Product Name', source: 'lineItem.title' },
  { column: 'D', header: 'Qty', source: 'lineItem.quantity' },
  { column: 'E', header: 'Product Price', source: 'lineItem.price' },
  { column: 'F', header: 'Full Name', source: 'fullName' },
  { column: 'G', header: 'Phone', source: 'phone' },
  { column: 'H', header: 'Address', source: 'fullAddress' },
  { column: 'I', header: 'City', source: 'city' },
  { column: 'J', header: 'PIN Code', source: 'postalCode' },
  { column: 'K', header: 'Total', source: 'total' },
  { column: 'L', header: 'Status', source: 'status' },
];

/** Spreadsheet column letter for a zero-based index: 0 -> A, 26 -> AA. */
export function columnLetter(index: number): string {
  let result = '';
  let remaining = index;

  // Spreadsheet columns are bijective base-26 — there is no zero digit, so A is
  // 1 rather than 0, and the usual base conversion is off by one at each step.
  while (remaining >= 0) {
    result = String.fromCharCode((remaining % 26) + 65) + result;
    remaining = Math.floor(remaining / 26) - 1;
  }

  return result;
}

/** Sheets' hard ceiling on columns in a new sheet. */
export const MAX_SHEET_COLUMNS = 26;

// ---------------------------------------------------------------------------
// Admin API payloads
// ---------------------------------------------------------------------------

export interface GoogleAccountSummary {
  readonly email: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly connectedAt: string;
  /** Set when Google rejected the refresh token and the merchant must reconnect. */
  readonly revokedAt: string | null;
  readonly lastError: string | null;
}

export interface SpreadsheetSummary {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly modifiedAt: string | null;
}

export interface WorksheetSummary {
  readonly gid: number;
  readonly title: string;
  readonly index: number;
}

/** How a multi-item order becomes rows. Mirrors the two merchant checkboxes. */
export interface SheetRowLayout {
  readonly singleRowPerOrder: boolean;
  readonly insertAtTop: boolean;
}

export interface SheetConfigSummary {
  readonly id: string;
  readonly spreadsheetId: string;
  readonly spreadsheetName: string | null;
  readonly spreadsheetUrl: string | null;
  readonly worksheetName: string;
  readonly worksheetGid: number | null;
  readonly isActive: boolean;
  readonly autoSync: boolean;
  readonly includeHeaders: boolean;
  readonly layout: SheetRowLayout;
  readonly columnMapping: readonly SheetColumnMapping[];
  readonly lastSyncedAt: string | null;
  readonly lastSyncStatus: string | null;
  readonly lastError: string | null;
  readonly totalSynced: number;
  readonly totalFailed: number;
}

/** Response of the Google Sheets settings screen's single bootstrap call. */
export interface SheetsOverview {
  readonly account: GoogleAccountSummary | null;
  readonly config: SheetConfigSummary | null;
  /** Custom form-field keys the merchant can map, gathered from their forms. */
  readonly customFieldSources: readonly { key: string; label: string }[];
}

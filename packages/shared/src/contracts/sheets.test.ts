import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMN_MAPPING,
  SHEET_FIELD_SOURCES,
  columnLetter,
  isCustomFieldSource,
  isLineItemSource,
  sheetFieldSource,
} from './sheets.js';

describe('columnLetter', () => {
  /**
   * Spreadsheet columns are bijective base-26: there is no zero digit, so A is
   * 1 rather than 0 and ordinary base conversion is off by one at each step.
   * The Z→AA and AZ→BA boundaries are where a naive implementation breaks.
   */
  it.each([
    [0, 'A'],
    [1, 'B'],
    [25, 'Z'],
    [26, 'AA'],
    [27, 'AB'],
    [51, 'AZ'],
    [52, 'BA'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('maps index %i to %s', (index, expected) => {
    expect(columnLetter(index)).toBe(expected);
  });
});

describe('field source catalogue', () => {
  it('has no duplicate keys', () => {
    // A duplicate would make the mapping dropdown offer the same field twice
    // and break the "one field per column" guarantee.
    const keys = SHEET_FIELD_SOURCES.map((source) => source.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every source a non-empty default header', () => {
    const missing = SHEET_FIELD_SOURCES.filter((source) => !source.defaultHeader.trim());
    expect(missing).toEqual([]);
  });

  it('scopes every lineItem.* key as a line item', () => {
    const mismatched = SHEET_FIELD_SOURCES.filter(
      (source) => source.key.startsWith('lineItem.') !== (source.scope === 'lineItem'),
    );
    expect(mismatched).toEqual([]);
  });

  it('resolves a known key', () => {
    expect(sheetFieldSource('phone')?.label).toBe('Phone');
  });

  it('returns undefined for a custom field, which is not in the catalogue', () => {
    expect(sheetFieldSource('customFields.landmark')).toBeUndefined();
  });
});

describe('source classification', () => {
  it('identifies line-item sources', () => {
    expect(isLineItemSource('lineItem.title')).toBe(true);
    expect(isLineItemSource('phone')).toBe(false);
  });

  it('identifies custom field sources', () => {
    expect(isCustomFieldSource('customFields.landmark')).toBe(true);
    expect(isCustomFieldSource('phone')).toBe(false);
  });
});

describe('DEFAULT_COLUMN_MAPPING', () => {
  it('references only real sources', () => {
    const unknown = DEFAULT_COLUMN_MAPPING.filter((column) => !sheetFieldSource(column.source));
    expect(unknown).toEqual([]);
  });

  it('assigns sequential column letters', () => {
    // The sync writes cells by position, so the letters and the array order
    // must agree or the sheet will not match the mapping screen.
    DEFAULT_COLUMN_MAPPING.forEach((column, index) => {
      expect(column.column).toBe(columnLetter(index));
    });
  });

  it('maps each field only once', () => {
    const sources = DEFAULT_COLUMN_MAPPING.map((column) => column.source);
    expect(new Set(sources).size).toBe(sources.length);
  });
});

import { describe, expect, it } from 'vitest';
import { FormFieldInputSchema, ReplaceFieldsSchema } from './dto';

/**
 * Form builder input validation.
 *
 * What a merchant saves here becomes executable configuration: a regular
 * expression runs against every shopper's keystrokes, and a field key becomes a
 * JSON property and a Google Sheets column source. Accepting a malformed one
 * produces a form that looks fine in the builder and is broken on the
 * storefront.
 */

function field(overrides: Record<string, unknown> = {}) {
  return {
    key: 'landmark',
    type: 'TEXT',
    label: 'Landmark',
    ...overrides,
  };
}

describe('field keys', () => {
  it.each(['landmark', 'gstNumber', 'field_2', 'a'])('accepts %s', (key) => {
    expect(FormFieldInputSchema.safeParse(field({ key })).success).toBe(true);
  });

  it.each([
    ['a dot, which the Sheets mapping uses as a path separator', 'custom.field'],
    ['a leading digit', '2field'],
    ['whitespace', 'my field'],
    ['a hyphen', 'my-field'],
    ['empty', ''],
  ])('rejects %s', (_label, key) => {
    expect(FormFieldInputSchema.safeParse(field({ key })).success).toBe(false);
  });
});

describe('regex safety', () => {
  it('accepts an ordinary pattern', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, pattern: '^[0-9]{6}$' } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a pattern that does not compile', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, pattern: '([a-z' } }),
    );
    expect(result.success).toBe(false);
  });

  /**
   * The shape that actually causes catastrophic backtracking: a quantifier
   * applied to a group that itself contains one. A merchant pasting `^(a+)+$`
   * from a forum would hang both the shopper's browser and the API.
   */
  it.each([
    ['nested quantifier', '^(a+)+$'],
    ['nested star', '^(a*)*$'],
    ['quantified alternation', '^(a|a)*$'],
    ['bounded then repeated', '^(a{1,9})+$'],
  ])('rejects a %s', (_label, pattern) => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, pattern } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an over-long pattern', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, pattern: 'a'.repeat(600) } }),
    );
    expect(result.success).toBe(false);
  });

  /**
   * False positives are acceptable — a merchant can simplify a rejected
   * pattern, but cannot undo taking down their own storefront. This documents
   * that the heuristic is deliberately blunt.
   */
  it('rejects a safe-but-nested-looking pattern, by design', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, pattern: '(ab+)+' } }),
    );
    expect(result.success).toBe(false);
  });
});

describe('validation bounds', () => {
  it('rejects a minimum length above the maximum', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, minLength: 10, maxLength: 5 } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a minimum value above the maximum', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, minValue: 10, maxValue: 5 } }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts equal bounds', () => {
    const result = FormFieldInputSchema.safeParse(
      field({ validation: { required: false, minLength: 6, maxLength: 6 } }),
    );
    expect(result.success).toBe(true);
  });
});

describe('conditional rules', () => {
  it('requires a value for a binary operator', () => {
    const result = FormFieldInputSchema.safeParse(
      field({
        conditional: { logic: 'all', conditions: [{ field: 'country', operator: 'equals' }] },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('allows a unary operator with no value', () => {
    const result = FormFieldInputSchema.safeParse(
      field({
        conditional: { logic: 'all', conditions: [{ field: 'country', operator: 'is_empty' }] },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('bounds the number of conditions', () => {
    // Each is evaluated on every keystroke, and the visibility resolver runs a
    // pass per field.
    const result = FormFieldInputSchema.safeParse(
      field({
        conditional: {
          logic: 'all',
          conditions: Array.from({ length: 11 }, () => ({
            field: 'country',
            operator: 'equals',
            value: 'IN',
          })),
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('ReplaceFieldsSchema', () => {
  it('requires at least one field', () => {
    expect(ReplaceFieldsSchema.safeParse({ fields: [] }).success).toBe(false);
  });

  it('bounds the field count', () => {
    const fields = Array.from({ length: 61 }, (_, index) => field({ key: `f${index}` }));
    expect(ReplaceFieldsSchema.safeParse({ fields }).success).toBe(false);
  });

  it('accepts a realistic form', () => {
    const fields = [field({ key: 'phone', type: 'PHONE', label: 'Phone' }), field()];
    expect(ReplaceFieldsSchema.safeParse({ fields }).success).toBe(true);
  });
});

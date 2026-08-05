import { describe, expect, it } from 'vitest';
import type { FormFieldDefinition } from '../contracts/forms.js';
import { coerceValue, validateField } from './fields.js';

/**
 * Field validation.
 *
 * Runs unchanged in the shopper's browser and in the API — the browser's copy
 * for immediate feedback, the API's to decide whether an order is created.
 * Because it is the same function, these tests cover both.
 */

function field(overrides: Partial<FormFieldDefinition> = {}): FormFieldDefinition {
  return {
    id: 'f',
    key: 'f',
    type: 'TEXT',
    label: 'Field',
    placeholder: null,
    helpText: null,
    position: 0,
    enabled: true,
    system: false,
    hidden: false,
    defaultValue: null,
    validation: { required: false },
    options: [],
    conditional: null,
    columnWidth: 12,
    cssClass: null,
    translations: {},
    ...overrides,
  };
}

describe('coerceValue', () => {
  it.each([
    ['true', true],
    ['on', true],
    ['1', true],
    ['yes', true],
    ['', false],
    ['off', false],
  ])('coerces checkbox value %s to %s', (input, expected) => {
    // HTML checkboxes post "on", "true" or "1" depending on the markup, and
    // nothing at all when unchecked.
    expect(coerceValue(field({ type: 'CHECKBOX' }), input)).toBe(expected);
  });

  it('coerces a multiselect scalar into an array', () => {
    expect(coerceValue(field({ type: 'MULTISELECT' }), 'a')).toEqual(['a']);
    expect(coerceValue(field({ type: 'MULTISELECT' }), '')).toEqual([]);
  });

  it('trims text values', () => {
    expect(coerceValue(field(), '  hello  ')).toBe('hello');
  });

  /**
   * NaN is preserved rather than nulled. "abc" in a number field is an error
   * the shopper should see, not a silently empty field.
   */
  it('preserves NaN for non-numeric input in a number field', () => {
    expect(Number.isNaN(coerceValue(field({ type: 'NUMBER' }), 'abc') as number)).toBe(true);
  });

  it('nulls an empty number field', () => {
    expect(coerceValue(field({ type: 'NUMBER' }), '')).toBeNull();
  });
});

describe('validateField', () => {
  it('returns null for a presentational field', () => {
    expect(validateField(field({ type: 'HEADING', validation: { required: true } }), null)).toBeNull();
  });

  it('returns null for a disabled field', () => {
    expect(validateField(field({ enabled: false, validation: { required: true } }), '')).toBeNull();
  });

  it('reports a missing required value', () => {
    expect(validateField(field({ validation: { required: true } }), '')?.code).toBe('required');
  });

  it('accepts an empty optional value', () => {
    expect(validateField(field(), '')).toBeNull();
  });

  describe('length', () => {
    it('rejects a value that is too short', () => {
      expect(
        validateField(field({ validation: { required: false, minLength: 5 } }), 'abc')?.code,
      ).toBe('too_short');
    });

    it('rejects a value that is too long', () => {
      expect(
        validateField(field({ validation: { required: false, maxLength: 2 } }), 'abc')?.code,
      ).toBe('too_long');
    });
  });

  describe('numeric range', () => {
    const numeric = (validation: FormFieldDefinition['validation']) =>
      field({ type: 'NUMBER', validation });

    it('rejects a value below the minimum', () => {
      expect(validateField(numeric({ required: false, minValue: 1 }), '0')?.code).toBe('too_small');
    });

    it('rejects a value above the maximum', () => {
      expect(validateField(numeric({ required: false, maxValue: 5 }), '6')?.code).toBe('too_large');
    });

    it('reports non-numeric input distinctly from missing input', () => {
      expect(validateField(numeric({ required: false }), 'abc')?.code).toBe('not_a_number');
    });

    it('accepts zero when the minimum allows it', () => {
      expect(validateField(numeric({ required: false, minValue: 0 }), '0')).toBeNull();
    });
  });

  describe('email', () => {
    it.each(['a@b.co', 'first.last+tag@sub.example.com'])('accepts %s', (value) => {
      expect(validateField(field({ type: 'EMAIL' }), value)).toBeNull();
    });

    it.each(['plain', 'a@b', 'a b@c.com', '@b.com'])('rejects %s', (value) => {
      expect(validateField(field({ type: 'EMAIL' }), value)?.code).toBe('invalid_email');
    });
  });

  describe('consent', () => {
    const consent = field({ type: 'CONSENT', validation: { required: true } });

    it('rejects an unticked required consent box', () => {
      // A false boolean is a valid value but not valid consent, so it gets its
      // own code rather than reporting as "required".
      expect(validateField(consent, false)?.code).toBe('consent_required');
    });

    it('accepts a ticked box', () => {
      expect(validateField(consent, 'on')).toBeNull();
    });

    it('accepts an unticked optional box', () => {
      expect(validateField(field({ type: 'CONSENT' }), false)).toBeNull();
    });
  });

  describe('options', () => {
    const select = field({
      type: 'SELECT',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
    });

    it('accepts a configured option', () => {
      expect(validateField(select, 'a')).toBeNull();
    });

    it('rejects a value that is not an option', () => {
      // The shopper cannot type this through the UI — it means the payload was
      // crafted, which is exactly why the server re-runs this.
      expect(validateField(select, 'c')?.code).toBe('invalid_option');
    });
  });

  describe('merchant pattern', () => {
    it('enforces a valid pattern', () => {
      expect(
        validateField(field({ validation: { required: false, pattern: '^[0-9]{6}$' } }), '12345')
          ?.code,
      ).toBe('pattern');
    });

    /**
     * A merchant can save a broken pattern through an older build. It must not
     * block a shopper — a form nobody can submit is worse than an unenforced
     * rule.
     */
    it('ignores an uncompilable pattern rather than throwing', () => {
      expect(validateField(field({ validation: { required: false, pattern: '([a-z' } }), 'x')).toBeNull();
    });

    it('ignores an over-long pattern', () => {
      const huge = `${'a'.repeat(600)}`;
      expect(validateField(field({ validation: { required: false, pattern: huge } }), 'x')).toBeNull();
    });
  });

  it('prefers the merchant message over the generated one', () => {
    const custom = field({
      validation: { required: true, message: 'We need your PIN code to deliver.' },
    });
    expect(validateField(custom, '')?.message).toBe('We need your PIN code to deliver.');
  });

  it('reports only the first failure for a field', () => {
    // Both too short and pattern-violating; the shopper sees one reason.
    const both = field({ validation: { required: false, minLength: 10, pattern: '^[0-9]+$' } });
    expect(validateField(both, 'abc')?.code).toBe('too_short');
  });
});

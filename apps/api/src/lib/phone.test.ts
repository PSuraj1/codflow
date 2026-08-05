import { describe, expect, it } from 'vitest';
import { looksFabricated, normalizePhone } from './phone';

/**
 * Phone normalization.
 *
 * The load-bearing field of a COD order: it is how the merchant confirms before
 * dispatch and how the fraud engine recognises a repeat offender. Both need one
 * canonical form, because the same person types the number three different ways
 * across three visits.
 */

describe('normalizePhone', () => {
  it('normalizes a national number using the country hint', () => {
    const result = normalizePhone('09876543210', 'IN');

    expect(result.valid).toBe(true);
    expect(result.e164).toBe('+919876543210');
    expect(result.countryCode).toBe('IN');
  });

  it('normalizes an already-international number without a hint', () => {
    expect(normalizePhone('+91 98765 43210').e164).toBe('+919876543210');
  });

  it.each([
    ['spaces', '+91 98765 43210'],
    ['dashes', '+91-98765-43210'],
    ['parentheses', '+91 (98765) 43210'],
  ])('ignores %s', (_label, input) => {
    expect(normalizePhone(input).e164).toBe('+919876543210');
  });

  /**
   * The reason the country hint exists: `9876543210` is a valid Indian mobile
   * and an invalid US number, and libphonenumber cannot tell which was meant
   * without a region.
   */
  it('uses the country to disambiguate the same digits', () => {
    expect(normalizePhone('9876543210', 'IN').valid).toBe(true);
    expect(normalizePhone('9876543210', 'US').valid).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['letters', 'not-a-number'],
    ['too short', '123'],
  ])('reports %s as invalid', (_label, input) => {
    const result = normalizePhone(input);
    expect(result.valid).toBe(false);
  });

  it('does not throw on hostile input', () => {
    // libphonenumber throws on some malformed inputs rather than returning
    // undefined; an unparseable number is a validation result, not an outage.
    expect(() => normalizePhone('+'.repeat(500))).not.toThrow();
    expect(normalizePhone('+'.repeat(500)).valid).toBe(false);
  });

  it('handles an unknown country hint gracefully', () => {
    expect(() => normalizePhone('9876543210', 'ZZ')).not.toThrow();
  });
});

describe('looksFabricated', () => {
  it.each([
    ['all identical digits', '+911111111111'],
    ['ascending run', '+911234567890'],
    ['descending run', '+919876543210'],
  ])('flags %s', (_label, input) => {
    expect(looksFabricated(input)).toBe(true);
  });

  /**
   * Deliberately conservative — a false positive here rejects a real customer's
   * order, so it only flags sequences no real allocation plan would produce.
   */
  it.each([
    ['an ordinary number', '+919812345678'],
    ['a repeated pair', '+919090909090'],
  ])('does not flag %s', (_label, input) => {
    expect(looksFabricated(input)).toBe(false);
  });

  it('does not flag a short number it cannot judge', () => {
    expect(looksFabricated('+1234')).toBe(false);
  });
});

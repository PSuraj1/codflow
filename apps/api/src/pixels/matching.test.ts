import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildMatching,
  compact,
  matchingStrength,
  normalizeCountry,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeState,
  normalizeZip,
} from './matching';

/**
 * Advanced matching.
 *
 * The reason this file is thorough: a normalization bug does not throw. It
 * produces a perfectly valid SHA-256 hash that no ad platform recognises, and
 * the merchant sees match quality quietly sitting at zero with nothing in any
 * log to explain it. Every rule below is one a provider specifies and one that
 * silently costs attribution if it drifts.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Asha@Example.COM ')).toBe('asha@example.com');
  });

  /**
   * Deliberately *not* stripping Gmail dots or plus-suffixes. Providers hash
   * the address as the user typed it, so canonicalising further would produce a
   * hash they have never seen.
   */
  it('preserves dots and plus-addressing', () => {
    expect(normalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
  });

  it.each([['no at sign', 'not-an-email'], ['empty', ''], ['null', null]])(
    'returns null for %s',
    (_label, input) => {
      expect(normalizeEmail(input as string)).toBeNull();
    },
  );
});

describe('normalizePhone', () => {
  /**
   * The single most common advanced-matching mistake. The pipeline stores
   * E.164 (`+919876543210`); leaving the `+` on changes the hash and drops the
   * match rate to zero without any error.
   */
  it('strips the leading plus from E.164', () => {
    expect(normalizePhone('+919876543210')).toBe('919876543210');
  });

  it.each([
    ['spaces', '+91 98765 43210'],
    ['dashes', '+91-98765-43210'],
    ['parentheses', '+91 (98765) 43210'],
  ])('strips %s', (_label, input) => {
    expect(normalizePhone(input)).toBe('919876543210');
  });

  it('strips leading zeros from a trunk-prefixed number', () => {
    expect(normalizePhone('00919876543210')).toBe('919876543210');
  });

  it.each([['too short', '12345'], ['empty', ''], ['letters only', 'abcdefghij']])(
    'returns null for %s',
    (_label, input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

describe('normalizeName', () => {
  it('lowercases and removes punctuation', () => {
    // `O'Brien` and `o brien` are one person; providers normalize them the same
    // way, so matching depends on doing it here too.
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName('o brien')).toBe('obrien');
  });

  it('strips accents', () => {
    expect(normalizeName('José')).toBe('jose');
    expect(normalizeName('Müller')).toBe('muller');
  });

  it('returns null when nothing survives normalization', () => {
    expect(normalizeName('...')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
  });
});

describe('normalizeZip', () => {
  it('lowercases and removes spaces', () => {
    expect(normalizeZip('SW1A 1AA', 'GB')).toBe('sw1a1aa');
  });

  /**
   * Meta specifies the first five digits for US ZIPs. Applying that truncation
   * to a UK postcode would match the wrong area entirely, so it is scoped to
   * the US.
   */
  it('truncates a US ZIP+4 to five digits', () => {
    expect(normalizeZip('94107-1234', 'US')).toBe('94107');
  });

  it('leaves a non-US postcode whole', () => {
    expect(normalizeZip('411001', 'IN')).toBe('411001');
    expect(normalizeZip('K1A 0B1', 'CA')).toBe('k1a0b1');
  });
});

describe('normalizeState and normalizeCountry', () => {
  it('lowercases a state code', () => {
    expect(normalizeState('MH')).toBe('mh');
  });

  it('passes a full state name through rather than guessing a code', () => {
    // An incorrect two-letter code is worse than a long one — it may match a
    // different region entirely.
    expect(normalizeState('Maharashtra')).toBe('maharashtra');
  });

  it('accepts only a two-letter country code', () => {
    expect(normalizeCountry('IN')).toBe('in');
    // A full name would hash to something no provider recognises.
    expect(normalizeCountry('India')).toBeNull();
  });
});

describe('buildMatching', () => {
  it('hashes each normalized value with SHA-256', () => {
    const result = buildMatching({ email: 'Asha@Example.com' });
    expect(result.email).toBe(sha256('asha@example.com'));
  });

  it('hashes the phone without its plus', () => {
    const result = buildMatching({ phone: '+919876543210' });
    expect(result.phone).toBe(sha256('919876543210'));
  });

  /**
   * `sha256("")` is a valid-looking hex value that every provider compares
   * against and never matches. Sending it for every shopper who omitted a field
   * would make match quality worse, not better.
   */
  it('leaves absent fields null rather than hashing an empty string', () => {
    const result = buildMatching({ email: 'a@b.co' });

    expect(result.phone).toBeNull();
    expect(result.firstName).toBeNull();
    expect(result.zip).toBeNull();
  });

  it('produces the same hash for differently-typed versions of one person', () => {
    const first = buildMatching({ firstName: '  JOSÉ ', lastName: "O'Brien" });
    const second = buildMatching({ firstName: 'jose', lastName: 'obrien' });

    expect(first.firstName).toBe(second.firstName);
    expect(first.lastName).toBe(second.lastName);
  });

  it('never returns anything resembling the plaintext', () => {
    const result = buildMatching({ email: 'asha@example.com', phone: '+919876543210' });

    expect(result.email).not.toContain('asha');
    expect(result.phone).not.toContain('9876');
    expect(result.email).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('compact', () => {
  it('drops null and undefined', () => {
    // Providers reject explicit nulls in the payload.
    expect(compact({ a: 1, b: null, c: undefined })).toEqual({ a: 1 });
  });

  it('drops empty arrays', () => {
    expect(compact({ contents: [], id: 'x' })).toEqual({ id: 'x' });
  });

  it('keeps falsy values that are meaningful', () => {
    expect(compact({ value: 0, flag: false })).toEqual({ value: 0, flag: false });
  });
});

describe('matchingStrength', () => {
  it('counts resolved identifiers', () => {
    // Surfaced in the admin so a merchant whose form collects no email is told
    // why their attribution is weak, rather than left to guess.
    expect(matchingStrength(buildMatching({ email: 'a@b.co', phone: '+919876543210' }))).toBe(2);
    expect(matchingStrength(buildMatching({}))).toBe(0);
  });
});

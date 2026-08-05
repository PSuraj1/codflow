import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hmacDigest, randomToken, safeCompare, stableHash, tryDecrypt } from './crypto';

/**
 * Encryption at rest.
 *
 * Guards Google refresh tokens, pixel Conversions API tokens and OTP provider
 * credentials. The property that matters is not just "it round-trips" but that
 * tampering is *detected* — GCM authenticates the ciphertext, and silently
 * returning garbage plaintext instead would be worse than failing.
 */

describe('encrypt / decrypt', () => {
  it('round-trips a value', () => {
    expect(decrypt(encrypt('a-google-refresh-token'))).toBe('a-google-refresh-token');
  });

  it('round-trips unicode and empty strings', () => {
    expect(decrypt(encrypt('कैश ऑन डिलीवरी 🚚'))).toBe('कैश ऑन डिलीवरी 🚚');
    expect(decrypt(encrypt(''))).toBe('');
  });

  /**
   * A fresh IV per encryption is mandatory for GCM — reusing one with the same
   * key destroys confidentiality and allows forgery. Identical plaintext
   * producing identical ciphertext would be the visible symptom.
   */
  it('produces different ciphertext for the same plaintext', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('emits the versioned envelope', () => {
    const parts = encrypt('x').split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  describe('tamper detection', () => {
    it('rejects a modified ciphertext', () => {
      const envelope = encrypt('sensitive').split('.');
      const tampered = [envelope[0], envelope[1], envelope[2], `${envelope[3]}AA`].join('.');
      expect(() => decrypt(tampered)).toThrow();
    });

    it('rejects a modified auth tag', () => {
      const envelope = encrypt('sensitive').split('.');
      const tampered = [envelope[0], envelope[1], 'AAAAAAAAAAAAAAAAAAAAAA', envelope[3]].join('.');
      expect(() => decrypt(tampered)).toThrow();
    });

    it('rejects an unknown version', () => {
      const envelope = encrypt('sensitive').split('.');
      expect(() => decrypt(['v2', envelope[1], envelope[2], envelope[3]].join('.'))).toThrow();
    });

    it.each([['too-few.parts'], ['not-an-envelope'], ['']])('rejects malformed input %s', (bad) => {
      expect(() => decrypt(bad)).toThrow();
    });
  });
});

describe('tryDecrypt', () => {
  it('returns the plaintext when it can', () => {
    expect(tryDecrypt(encrypt('ok'))).toBe('ok');
  });

  /**
   * For call sites that can degrade — showing "reconnect your Google account"
   * rather than throwing a 500 at a merchant looking at a settings page.
   */
  it('returns null rather than throwing on bad input', () => {
    expect(tryDecrypt('garbage')).toBeNull();
    expect(tryDecrypt(null)).toBeNull();
    expect(tryDecrypt(undefined)).toBeNull();
  });
});

describe('safeCompare', () => {
  it('matches identical strings', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
  });

  it('rejects different strings', () => {
    expect(safeCompare('abc', 'abd')).toBe(false);
  });

  /**
   * timingSafeEqual throws on a length mismatch, which would itself leak the
   * length. The implementation compares equal-size digests instead, so this
   * must return false rather than blow up.
   */
  it('handles different lengths without throwing', () => {
    expect(safeCompare('short', 'much-longer-value')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'x')).toBe(false);
  });
});

describe('hmacDigest', () => {
  it('is deterministic', () => {
    expect(hmacDigest('123456')).toBe(hmacDigest('123456'));
  });

  it('differs for different inputs', () => {
    expect(hmacDigest('123456')).not.toBe(hmacDigest('123457'));
  });

  it('does not contain the plaintext', () => {
    expect(hmacDigest('123456')).not.toContain('123456');
  });
});

describe('stableHash', () => {
  /**
   * Powers duplicate-address fraud detection, so `12 High St.` and
   * `12  HIGH ST.` must collapse to the same value — but only after the caller
   * has normalised internal whitespace, which is its documented contract.
   */
  it('ignores case and surrounding whitespace', () => {
    expect(stableHash('  12 High St  ')).toBe(stableHash('12 HIGH ST'));
  });

  it('distinguishes genuinely different values', () => {
    expect(stableHash('12 High St')).not.toBe(stableHash('13 High St'));
  });
});

describe('randomToken', () => {
  it('produces URL-safe output', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
  });
});

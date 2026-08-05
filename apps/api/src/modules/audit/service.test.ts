import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { sanitizeAuditSnapshot } from './service';

/**
 * Audit snapshot redaction.
 *
 * Audit rows are kept indefinitely, so anything that reaches them is retained
 * forever. The redaction list uses broad substrings deliberately — a column
 * added in a later phase should be redacted *by default* rather than by
 * somebody remembering to update this file — and these tests pin that
 * behaviour so a future refactor cannot narrow it silently.
 */

describe('sanitizeAuditSnapshot', () => {
  describe('secret redaction', () => {
    it.each([
      'accessToken',
      'refreshToken',
      'accessTokenEnc',
      'msg91AuthKey',
      'twilioAuthToken',
      'apiKey',
      'api_key',
      'password',
      'clientSecret',
      'codeHash',
      'firebaseServiceAccount',
    ])('redacts %s', (key) => {
      const result = sanitizeAuditSnapshot({ [key]: 'super-secret-value' }) as Record<string, unknown>;
      expect(result[key]).toBe('[redacted]');
    });

    it('matches case-insensitively', () => {
      const result = sanitizeAuditSnapshot({ ACCESSTOKEN: 'x', AccessToken: 'y' }) as Record<
        string,
        unknown
      >;
      expect(result.ACCESSTOKEN).toBe('[redacted]');
      expect(result.AccessToken).toBe('[redacted]');
    });

    it('redacts nested secrets', () => {
      const result = sanitizeAuditSnapshot({
        settings: { google: { refreshToken: 'leaked' } },
      }) as Record<string, Record<string, Record<string, unknown>>>;

      expect(result.settings?.google?.refreshToken).toBe('[redacted]');
    });

    it('redacts secrets inside arrays', () => {
      const result = sanitizeAuditSnapshot({
        pixels: [{ label: 'Meta', accessToken: 'leaked' }],
      }) as { pixels: Array<Record<string, unknown>> };

      expect(result.pixels[0]?.accessToken).toBe('[redacted]');
      expect(result.pixels[0]?.label).toBe('Meta');
    });

    it('keeps ordinary fields intact', () => {
      const result = sanitizeAuditSnapshot({ name: 'Default COD Form', enabled: true }) as Record<
        string,
        unknown
      >;

      expect(result.name).toBe('Default COD Form');
      expect(result.enabled).toBe(true);
    });
  });

  describe('type normalisation', () => {
    /**
     * Prisma hands back Decimal and Date instances. `JSON.stringify` renders a
     * Decimal as an object and a Date as a string, so an audit diff of two
     * amounts would compare unlike shapes.
     */
    it('renders a Decimal as its string value', () => {
      expect(sanitizeAuditSnapshot({ total: new Prisma.Decimal('1209.00') })).toEqual({
        total: '1209',
      });
    });

    it('renders a Date as an ISO string', () => {
      expect(sanitizeAuditSnapshot({ at: new Date('2026-07-28T09:15:30Z') })).toEqual({
        at: '2026-07-28T09:15:30.000Z',
      });
    });

    it('renders a bigint as a string', () => {
      expect(sanitizeAuditSnapshot({ id: 123n })).toEqual({ id: '123' });
    });

    it('passes primitives through', () => {
      expect(sanitizeAuditSnapshot({ a: 1, b: 'x', c: false })).toEqual({ a: 1, b: 'x', c: false });
    });

    it('redacts a function rather than dropping it silently', () => {
      const result = sanitizeAuditSnapshot({ fn: () => undefined }) as Record<string, unknown>;
      expect(result.fn).toBe('[redacted]');
    });
  });

  describe('depth limit', () => {
    /**
     * A cyclic or pathologically deep object would otherwise recurse until the
     * stack gives out — inside a function whose whole contract is "never throw".
     */
    it('truncates beyond the maximum depth', () => {
      let deep: Record<string, unknown> = { value: 'bottom' };
      for (let i = 0; i < 20; i += 1) deep = { nested: deep };

      expect(() => sanitizeAuditSnapshot(deep)).not.toThrow();
      expect(JSON.stringify(sanitizeAuditSnapshot(deep))).toContain('[redacted]');
    });

    it('survives a cyclic object', () => {
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic.self = cyclic;

      expect(() => sanitizeAuditSnapshot(cyclic)).not.toThrow();
    });
  });
});

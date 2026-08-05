import { describe, expect, it } from 'vitest';
import { normalizeShopDomain, requireShopDomain, shopHandle } from './shopDomain';

/**
 * Shop domain sanitization.
 *
 * The check that stops a request from steering the app at a domain the caller
 * controls. Without it, `shop=evil.com` would make the app send a merchant's
 * access token to `evil.com/admin/api`.
 */

describe('normalizeShopDomain', () => {
  it.each([
    ['bare domain', 'demo.myshopify.com'],
    ['https scheme', 'https://demo.myshopify.com'],
    ['http scheme', 'http://demo.myshopify.com'],
    ['trailing path', 'demo.myshopify.com/admin'],
    ['scheme and path', 'https://demo.myshopify.com/admin/orders'],
    ['uppercase', 'DEMO.MYSHOPIFY.COM'],
    ['surrounding whitespace', '  demo.myshopify.com  '],
  ])('normalizes a %s', (_label, input) => {
    expect(normalizeShopDomain(input)).toBe('demo.myshopify.com');
  });

  it('strips a port', () => {
    // Never legitimate on a myshopify domain, but sanitizeShop would reject the
    // whole value rather than ignoring it.
    expect(normalizeShopDomain('demo.myshopify.com:443')).toBe('demo.myshopify.com');
  });

  it.each([
    ['a non-Shopify domain', 'evil.com'],
    ['a lookalike suffix', 'demo.myshopify.com.evil.com'],
    ['a subdomain prefix attack', 'evil.com/demo.myshopify.com'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a bare word', 'localhost'],
  ])('rejects %s', (_label, input) => {
    expect(normalizeShopDomain(input as string)).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(normalizeShopDomain('https://')).toBeNull();
  });
});

describe('requireShopDomain', () => {
  it('returns the normalized domain', () => {
    expect(requireShopDomain('https://demo.myshopify.com')).toBe('demo.myshopify.com');
  });

  it('throws on an invalid domain', () => {
    expect(() => requireShopDomain('evil.com')).toThrow(/valid myshopify\.com shop domain/i);
  });
});

describe('shopHandle', () => {
  it('extracts the store handle for admin deep links', () => {
    expect(shopHandle('demo.myshopify.com')).toBe('demo');
  });

  it('leaves a value without the suffix alone', () => {
    expect(shopHandle('demo')).toBe('demo');
  });
});

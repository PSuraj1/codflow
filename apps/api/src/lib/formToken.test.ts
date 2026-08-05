import { Buffer } from 'node:buffer';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { issueFormToken, tokenAgeSeconds, verifyFormToken } from './formToken';

/**
 * Storefront form tokens.
 *
 * The order endpoint is public — a shopper has no credentials — so this is what
 * stops anyone POSTing at it in a loop and manufacturing COD orders. It does
 * not authenticate the shopper; it proves the submission followed a real form
 * render, and it carries a signed issue time the client cannot lie about.
 */

const SHOP = 'demo.myshopify.com';
const FORM = 'clx000000000000000000000';

afterEach(() => {
  vi.useRealTimers();
});

describe('issueFormToken / verifyFormToken', () => {
  it('round-trips a token', () => {
    const result = verifyFormToken(issueFormToken(SHOP, FORM), SHOP);

    expect(result.valid).toBe(true);
    expect(result.payload?.shop).toBe(SHOP);
    expect(result.payload?.formId).toBe(FORM);
  });

  /**
   * Every shop's tokens are signed with the same application secret, so without
   * an explicit shop check a token minted on one store would be accepted on
   * another.
   */
  it('rejects a token issued for a different shop', () => {
    const result = verifyFormToken(issueFormToken(SHOP, FORM), 'other.myshopify.com');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('shop_mismatch');
  });

  it('rejects a tampered signature', () => {
    const token = issueFormToken(SHOP, FORM);
    const result = verifyFormToken(`${token.slice(0, -4)}AAAA`, SHOP);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  /**
   * The attack worth naming: re-point a captured token at another shop and
   * re-sign nothing. The payload changes, the signature does not, so it must
   * fail on the signature rather than on the shop comparison.
   */
  it('rejects a tampered payload', () => {
    const [version, body, signature] = issueFormToken(SHOP, FORM).split('.') as [
      string,
      string,
      string,
    ];

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      shop: string;
    };
    payload.shop = 'attacker.myshopify.com';

    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const result = verifyFormToken(`${version}.${forged}.${signature}`, 'attacker.myshopify.com');

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it.each([
    ['empty', ''],
    ['not an envelope', 'garbage'],
    ['too few parts', 'v1.body'],
    ['wrong version', 'v9.body.signature'],
  ])('rejects a %s token', (_label, token) => {
    expect(verifyFormToken(token, SHOP).valid).toBe(false);
  });

  it('expires after its lifetime', () => {
    const token = issueFormToken(SHOP, FORM);

    // 31 minutes on a 30-minute TTL.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60 * 1_000);

    const result = verifyFormToken(token, SHOP);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('is still valid just inside its lifetime', () => {
    const token = issueFormToken(SHOP, FORM);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 29 * 60 * 1_000);

    expect(verifyFormToken(token, SHOP).valid).toBe(true);
  });

  /**
   * A server clock that moved backwards should not invalidate a token a shopper
   * is holding — that would reject a real order for an operations problem.
   */
  it('tolerates a clock that moved backwards', () => {
    const token = issueFormToken(SHOP, FORM);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 60 * 1_000);

    expect(verifyFormToken(token, SHOP).valid).toBe(true);
  });

  it('produces a distinct token each time', () => {
    // The nonce keeps the value from being a useful cache key or a
    // cross-visitor correlator.
    const tokens = new Set(Array.from({ length: 50 }, () => issueFormToken(SHOP, FORM)));
    expect(tokens.size).toBe(50);
  });
});

describe('tokenAgeSeconds', () => {
  it('starts at zero', () => {
    const result = verifyFormToken(issueFormToken(SHOP, FORM), SHOP);
    expect(tokenAgeSeconds(result.payload!)).toBeLessThanOrEqual(1);
  });

  it('reports elapsed time', () => {
    const result = verifyFormToken(issueFormToken(SHOP, FORM), SHOP);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);

    expect(tokenAgeSeconds(result.payload!)).toBeGreaterThanOrEqual(9);
  });

  it('never reports a negative age', () => {
    const result = verifyFormToken(issueFormToken(SHOP, FORM), SHOP);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 60_000);

    // Clamped, because a negative age fed into the fill-duration check would
    // read as an impossibly fast submission and flag a real shopper as a bot.
    expect(tokenAgeSeconds(result.payload!)).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigateTop, openTop } from '../lib/appBridge';

/**
 * Escaping the app iframe.
 *
 * Both destinations that need it — Shopify's OAuth consent screen and Google's
 * — refuse to render inside a frame, so the app has to navigate the *top*
 * window. The trap is that `top.location.assign()` looks like the obvious way
 * and is blocked: reading any named property from a cross-origin `Location`
 * throws "Failed to read a named property 'assign' from 'Location'", which is
 * every embedded page view in production.
 *
 * It shipped that way and broke Connect Google account, the upgrade button and
 * the re-authorisation banner at once, so these pin the mechanism rather than
 * the outcome.
 */

const shopify = { open: vi.fn(), config: { shop: 'demo.myshopify.com' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { shopify?: unknown }).shopify;
});

describe('with App Bridge available', () => {
  beforeEach(() => {
    (window as unknown as { shopify: typeof shopify }).shopify = shopify;
  });

  it('routes an external URL through App Bridge, targeting the top frame', () => {
    navigateTop('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');

    expect(shopify.open).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      '_top',
    );
  });

  /** App-relative paths resolve against the app, not admin.shopify.com. */
  it('absolutises an app-relative path before navigating', () => {
    openTop('/api/auth/reauthorize?shop=demo.myshopify.com');

    expect(shopify.open).toHaveBeenCalledWith(
      `${window.location.origin}/api/auth/reauthorize?shop=demo.myshopify.com`,
      '_top',
    );
  });

  /**
   * The whole point: an absolute URL must survive untouched. Passing Google's
   * consent URL through `openTop` would rebuild it against the app's origin.
   */
  it('does not rewrite the origin of an absolute URL', () => {
    navigateTop('https://accounts.google.com/o/oauth2/v2/auth');

    const [target] = shopify.open.mock.calls[0] as [string, string];
    expect(target.startsWith('https://accounts.google.com')).toBe(true);
  });
});

describe('without App Bridge', () => {
  it('falls back to window.open targeting the top frame', () => {
    navigateTop('https://accounts.google.com/o/oauth2/v2/auth');

    expect(window.open).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth',
      '_top',
    );
  });

  /**
   * The regression guard. `top.location` must never be read — reading it
   * cross-origin is what threw. A throwing accessor fails the test if anything
   * reintroduces the pattern.
   */
  it('never touches top.location', () => {
    const trap = {
      get location(): never {
        throw new Error('Blocked a frame from accessing a cross-origin frame.');
      },
    };

    vi.stubGlobal('top', trap);

    expect(() => navigateTop('https://accounts.google.com/o/oauth2/v2/auth')).not.toThrow();
    expect(() => openTop('/api/auth/reauthorize')).not.toThrow();
  });
});

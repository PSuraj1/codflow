import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SOURCE from '../../extensions/codflow-theme/assets/codflow.js?raw';

/**
 * Whether a storefront notices that its cached config went stale.
 *
 * The bug this covers: the runtime kept a config in `sessionStorage` for five
 * minutes and never asked whether it was still current, so a merchant who
 * changed their COD fee reloaded the storefront, saw the old amount, and
 * concluded the setting had not saved. The API had been computing a `version`
 * hash for precisely this comparison since the beginning — the browser simply
 * never read it.
 *
 * `codflow.js` is a hand-written IIFE with no exports, so it is driven here the
 * way a storefront drives it: real DOM, a context script tag, and a stubbed
 * `XMLHttpRequest`. That is more setup than a unit test, and it is the only way
 * this file's behaviour can be covered at all.
 */

const SHOP = 'demo.myshopify.com';
const PRODUCT_ID = 555;
const CACHE_KEY = `codflow:config:${SHOP}:${PRODUCT_ID}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    eligible: true,
    version: 'v1',
    buttons: [],
    branding: {
      primaryColor: '#008060',
      secondaryColor: '#004C3F',
      textColor: '#202223',
      fontFamily: 'inherit',
      borderRadius: 8,
    },
    localization: { rtl: false },
    pricing: { codFeeEnabled: true, codFeeAmount: '30', codFeeIsPercent: false },
    ...overrides,
  };
}

/** Responses the stubbed transport will hand back, in order. */
let responses: unknown[] = [];
let requested: string[] = [];

function stubXhr() {
  class FakeXhr {
    status = 200;
    responseText = '';
    timeout = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    private url = '';

    open(_method: string, url: string) {
      this.url = url;
    }

    setRequestHeader() {}

    send() {
      requested.push(this.url);

      const body = responses.shift();

      // Asynchronous, like the real thing: resolving inline would hide ordering
      // bugs between the cached render and the revalidated one.
      setTimeout(() => {
        if (body === undefined) {
          this.status = 500;
          this.responseText = '';
        } else {
          this.responseText = JSON.stringify({ data: body });
        }
        this.onload?.();
      }, 0);
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}

function bootStorefront() {
  document.head.innerHTML = `
    <script type="application/json" id="codflow-context" data-codflow-context>
      ${JSON.stringify({
        shop: { domain: SHOP, currency: 'INR', moneyFormat: '₹{{amount}}', locale: 'en', rootUrl: '/', countryCode: 'IN' },
        page: { type: 'product', template: 'product', designMode: false },
        product: { id: PRODUCT_ID, variantId: 999, available: true, handle: 'p', title: 'P', price: 100 },
        cart: { itemCount: 0, totalPrice: 0 },
        customer: { isLoggedIn: false },
        theme: { stickyMobile: false, floating: false },
        strings: {},
      })}
    </script>`;

  document.body.innerHTML = '<div id="codflow-root" data-codflow-root hidden></div>';

  /* The bundle guards against being included twice by a theme
   * (`window.__codflowLoaded`), so without clearing it every test after the
   * first evaluates the file and silently does nothing. */
  delete (window as unknown as Record<string, unknown>).__codflowLoaded;

  // The IIFE runs on evaluation and boots immediately, because readyState is
  // already past "loading" in jsdom.
  new Function(SOURCE)();
}

/** Lets the boot promise chain and the stubbed transport settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  responses = [];
  requested = [];
  window.sessionStorage.clear();
  stubXhr();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('with nothing cached', () => {
  it('fetches the config and caches it', async () => {
    responses = [config()];

    bootStorefront();
    await settle();

    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('/apps/codflow/config');

    const cached = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) as string);

    expect(cached.config.version).toBe('v1');
  });

  it('does not ask twice — a fresh fetch needs no revalidation', async () => {
    responses = [config()];

    bootStorefront();
    await settle();

    expect(requested).toHaveLength(1);
  });
});

describe('with a cached config', () => {
  function seedCache(entry: Record<string, unknown>, ageMs = 0) {
    window.sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: Date.now() - ageMs, config: entry }),
    );
  }

  it('revalidates in the background instead of trusting the cache', async () => {
    seedCache(config({ version: 'old' }));
    responses = [config({ version: 'new' })];

    bootStorefront();
    await settle();

    // The whole point: a cached config is still checked.
    expect(requested).toHaveLength(1);
  });

  it('replaces the cache when the config has changed', async () => {
    seedCache(config({ version: 'old', pricing: { codFeeEnabled: true, codFeeAmount: '30' } }));
    responses = [config({ version: 'new', pricing: { codFeeEnabled: true, codFeeAmount: '99' } })];

    bootStorefront();
    await settle();

    const cached = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) as string);

    // The merchant's new fee, on the next page view rather than in five minutes.
    expect(cached.config.version).toBe('new');
    expect(cached.config.pricing.codFeeAmount).toBe('99');
  });

  it('keeps serving the cached copy when nothing changed', async () => {
    seedCache(config({ version: 'same' }));
    responses = [config({ version: 'same' })];

    bootStorefront();
    await settle();

    const cached = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) as string);

    expect(cached.config.version).toBe('same');
  });

  it('ignores a cache entry older than its lifetime', async () => {
    seedCache(config({ version: 'ancient' }), 6 * 60 * 1000);
    responses = [config({ version: 'fresh' })];

    bootStorefront();
    await settle();

    const cached = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) as string);

    expect(cached.config.version).toBe('fresh');
  });

  it('leaves the cached config in place when revalidation fails', async () => {
    seedCache(config({ version: 'old' }));
    responses = []; // the stub answers 500

    bootStorefront();
    await settle();

    const cached = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) as string);

    // A failed refresh must not blank a storefront that was working.
    expect(cached.config.version).toBe('old');
  });
});

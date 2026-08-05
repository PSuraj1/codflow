// @vitest-environment jsdom
import type { StorefrontPixel } from '@codflow/shared';
import { pixelEventId } from '@codflow/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  eligibility,
  emit,
  init,
  providerEventName,
  purchaseEvent,
  reset,
  type PixelPageContext,
} from './pixels';

/**
 * Client-side pixel firing.
 *
 * Two things here are worth more than the rest combined, because both fail
 * silently and both cost the merchant money:
 *
 *  - The Purchase event id must equal the one the server computes. If it does
 *    not, every COD sale is counted twice and the merchant's ad platform bids
 *    against a return that is double the truth.
 *  - The consent gate must hold. A marketing event fired for a shopper who
 *    declined is a privacy violation and an app-listing risk.
 *
 * The provider tag loaders are covered only to the extent that they queue calls
 * rather than throw — asserting on the exact shape of a payload that
 * `fbevents.js` will parse is a test of Meta's SDK, not of this file.
 */

function pixel(overrides: Partial<StorefrontPixel> = {}): StorefrontPixel {
  return {
    provider: 'META',
    pixelId: '1234567890',
    enabledEvents: [],
    advancedMatching: false,
    requireConsent: false,
    customScript: null,
    gtmContainerId: null,
    conversionId: null,
    conversionLabel: null,
    ...overrides,
  };
}

function context(overrides: Partial<PixelPageContext> = {}): PixelPageContext {
  return {
    shop: { domain: 'demo.myshopify.com', currency: 'INR', locale: 'en' },
    page: { type: 'product', designMode: false },
    product: { id: 55, variantId: 99, title: 'Kurta', price: 129_900 },
    ...overrides,
  };
}

/** Grants or withholds the answer Shopify's privacy API would give. */
function setConsent(marketing: boolean | null): void {
  const shopify = window as unknown as {
    Shopify?: { customerPrivacy?: { currentVisitorConsent?: () => Record<string, string> } };
  };

  if (marketing === null) {
    delete shopify.Shopify;
    return;
  }

  shopify.Shopify = {
    customerPrivacy: {
      currentVisitorConsent: () => ({ marketing: marketing ? 'yes' : 'no' }),
    },
  };
}

let fbq: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reset();
  setConsent(null);

  // Stand in for the real tag, which would otherwise be fetched over the
  // network. Present before init, so the loader's stub is never installed.
  fbq = vi.fn();
  (window as unknown as Record<string, unknown>).fbq = fbq;
});

afterEach(() => {
  reset();
  delete (window as unknown as Record<string, unknown>).fbq;
  delete (window as unknown as Record<string, unknown>).ttq;
  delete (window as unknown as Record<string, unknown>).snaptr;
  delete (window as unknown as Record<string, unknown>).pintrk;
});

/** The arguments of every `fbq('trackSingle', …)` call, in order. */
function tracked(): unknown[][] {
  return fbq.mock.calls.filter((call) => call[0] === 'trackSingle');
}

describe('eligibility', () => {
  it('sends when nothing narrows the pixel', () => {
    expect(eligibility(pixel(), 'PURCHASE', false)).toBe('send');
  });

  it('withholds an event from a pixel that requires consent it does not have', () => {
    expect(eligibility(pixel({ requireConsent: true }), 'PURCHASE', false)).toBe('no-consent');
    expect(eligibility(pixel({ requireConsent: true }), 'PURCHASE', true)).toBe('send');
  });

  it('treats an empty event list as every supported event, matching the server', () => {
    expect(eligibility(pixel({ enabledEvents: [] }), 'VIEW_CONTENT', true)).toBe('send');
  });

  it('honours a narrowed event list', () => {
    const narrowed = pixel({ enabledEvents: ['PURCHASE'] });

    expect(eligibility(narrowed, 'PURCHASE', true)).toBe('send');
    expect(eligibility(narrowed, 'VIEW_CONTENT', true)).toBe('not-enabled');
  });

  it('skips an event the provider has no equivalent for', () => {
    // Google Ads has conversion actions rather than an event vocabulary, so it
    // has no name for a page view. Sending one anyway would record a custom
    // event no campaign optimises against.
    expect(eligibility(pixel({ provider: 'GOOGLE_ADS' }), 'PAGE_VIEW', true)).toBe('unsupported');
    expect(eligibility(pixel({ provider: 'GOOGLE_ADS' }), 'PURCHASE', true)).toBe('send');
  });
});

describe('providerEventName', () => {
  it('uses each provider’s own vocabulary for one conversion', () => {
    expect(providerEventName('META', 'PURCHASE')).toBe('Purchase');
    expect(providerEventName('TIKTOK', 'PURCHASE')).toBe('CompletePayment');
    expect(providerEventName('SNAPCHAT', 'PURCHASE')).toBe('PURCHASE');
    expect(providerEventName('PINTEREST', 'PURCHASE')).toBe('checkout');
  });
});

describe('purchaseEvent', () => {
  it('derives the id the server will derive', () => {
    const event = purchaseEvent('COD-1042', '1499.00', context());

    // The single assertion this whole feature rests on: the dispatcher computes
    // `${reference}-${eventName}`.toLowerCase() for its own copy of the event.
    expect(event.eventId).toBe(pixelEventId('COD-1042', 'PURCHASE'));
    expect(event.eventId).toBe('cod-1042-purchase');
  });

  it('carries the order value and the shop currency', () => {
    const event = purchaseEvent('COD-1042', '1499.00', context());

    expect(event.value).toBe(1499);
    expect(event.currency).toBe('INR');
    expect(event.orderReference).toBe('COD-1042');
  });

  it('sends no value rather than a wrong one when the total is unparseable', () => {
    expect(purchaseEvent('COD-7', 'not-a-number', context()).value).toBeNull();
  });
});

describe('init', () => {
  it('fires a page view and a view content on a product page', () => {
    init({ pixels: [pixel()], context: context() });

    const names = tracked().map((call) => call[2]);
    expect(names).toEqual(['PageView', 'ViewContent']);
  });

  it('fires only a page view away from a product page', () => {
    init({ pixels: [pixel()], context: context({ page: { type: 'index', designMode: false } }) });

    expect(tracked().map((call) => call[2])).toEqual(['PageView']);
  });

  it('puts no value on a browse event', () => {
    init({ pixels: [pixel()], context: context() });

    const viewContent = tracked().find((call) => call[2] === 'ViewContent');
    expect(viewContent?.[3]).not.toHaveProperty('value');
  });

  it('addresses one tag out of several rather than every Meta pixel', () => {
    init({
      pixels: [pixel({ pixelId: 'aaa' }), pixel({ pixelId: 'bbb', enabledEvents: ['PURCHASE'] })],
      context: context(),
    });

    // Both are Meta; only the first accepts page views.
    expect(tracked().filter((call) => call[2] === 'PageView').map((call) => call[1])).toEqual(['aaa']);
  });

  it('does nothing at all when no pixel is configured', () => {
    init({ pixels: [], context: context() });

    expect(fbq).not.toHaveBeenCalled();
  });
});

describe('storefront events', () => {
  it('reports a purchase with the shared event id when an order is created', () => {
    init({ pixels: [pixel()], context: context() });

    document.dispatchEvent(
      new CustomEvent('codflow:order:created', {
        detail: { reference: 'COD-2001', total: '899.50' },
      }),
    );

    const purchase = tracked().find((call) => call[2] === 'Purchase');

    expect(purchase?.[3]).toMatchObject({ value: 899.5, currency: 'INR' });
    expect(purchase?.[4]).toEqual({ eventID: 'cod-2001-purchase' });
  });

  it('reports one purchase even when the event arrives twice', () => {
    init({ pixels: [pixel()], context: context() });

    const fire = (): void => {
      document.dispatchEvent(
        new CustomEvent('codflow:order:created', {
          detail: { reference: 'COD-2001', total: '899.50' },
        }),
      );
    };

    fire();
    fire();

    expect(tracked().filter((call) => call[2] === 'Purchase')).toHaveLength(1);
  });

  it('reports checkout initiation once however often the form is opened', () => {
    init({ pixels: [pixel()], context: context() });

    document.dispatchEvent(new CustomEvent('codflow:form:open'));
    document.dispatchEvent(new CustomEvent('codflow:form:open'));

    expect(tracked().filter((call) => call[2] === 'InitiateCheckout')).toHaveLength(1);
  });

  it('replays events that happened while the bundle was still loading', () => {
    // What the storefront runtime pushes when it emits before this file lands.
    (window as unknown as { CodFlowPixelQueue: unknown[] }).CodFlowPixelQueue = [
      { name: 'codflow:order:created', detail: { reference: 'COD-3003', total: '250' } },
    ];

    init({ pixels: [pixel()], context: context() });

    const purchase = tracked().find((call) => call[2] === 'Purchase');
    expect(purchase?.[4]).toEqual({ eventID: 'cod-3003-purchase' });
  });

  it('stops the queue growing once it is draining events directly', () => {
    init({ pixels: [pixel()], context: context() });

    const queue = (window as unknown as { CodFlowPixelQueue: { push(entry: unknown): unknown } })
      .CodFlowPixelQueue;

    queue.push({ name: 'codflow:form:open' });

    expect(Array.isArray(queue)).toBe(false);
  });
});

describe('consent', () => {
  it('does not fire a consent-gated pixel before the shopper has agreed', () => {
    setConsent(false);
    init({ pixels: [pixel({ requireConsent: true })], context: context() });

    expect(tracked()).toHaveLength(0);
  });

  it('fires the events it held back once consent is collected', () => {
    setConsent(false);
    init({ pixels: [pixel({ requireConsent: true })], context: context() });

    setConsent(true);
    document.dispatchEvent(new CustomEvent('visitorConsentCollected'));

    expect(tracked().map((call) => call[2])).toEqual(['PageView', 'ViewContent']);
  });

  it('treats an unavailable privacy API as no consent', () => {
    setConsent(null);
    init({ pixels: [pixel({ requireConsent: true })], context: context() });

    expect(tracked()).toHaveLength(0);
  });

  it('leaves a pixel that does not require consent alone', () => {
    setConsent(false);
    init({ pixels: [pixel({ requireConsent: false })], context: context() });

    expect(tracked()).toHaveLength(2);
  });
});

describe('failure containment', () => {
  it('keeps reporting to the other pixels when one provider’s tag throws', () => {
    fbq.mockImplementation((command: string) => {
      if (command === 'trackSingle') throw new Error('tag exploded');
    });

    const pintrk = vi.fn();
    (window as unknown as Record<string, unknown>).pintrk = pintrk;

    init({ pixels: [pixel(), pixel({ provider: 'PINTEREST', pixelId: 'pin-1' })], context: context() });

    expect(pintrk.mock.calls.some((call) => call[0] === 'page')).toBe(true);
  });

  it('sends nothing for a Google Ads pixel with no conversion label', () => {
    const gtag = vi.fn();
    (window as unknown as Record<string, unknown>).gtag = gtag;
    (window as unknown as Record<string, unknown>).dataLayer = [];

    init({ pixels: [pixel({ provider: 'GOOGLE_ADS', conversionId: 'AW-1' })], context: context() });

    document.dispatchEvent(
      new CustomEvent('codflow:order:created', { detail: { reference: 'COD-9', total: '10' } }),
    );

    // A conversion without a label has no action to report against; Google
    // records nothing, so sending it would only look like it worked.
    expect(gtag.mock.calls.some((call) => call[0] === 'event')).toBe(false);

    delete (window as unknown as Record<string, unknown>).gtag;
    delete (window as unknown as Record<string, unknown>).dataLayer;
  });
});

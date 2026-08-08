/**
 * CODkar — client-side pixel firing.
 *
 * Bundled by `build.mjs` into `assets/codflow-pixels.js` and loaded by
 * `codflow.js` only when the merchant has at least one pixel configured. A shop
 * with no pixels never fetches this file; a shop with pixels is already loading
 * far heavier third-party tags.
 *
 * It is bundled rather than written into `codflow.js` for the same reason
 * `form.ts` is: it imports `PROVIDER_EVENT_NAMES` and `pixelEventId` from
 * `@codflow/shared` — the exact table and the exact function the server uses.
 * Both halves have to agree on two things or the feature is worse than absent:
 *
 *  - **The event id.** `pixelEventId(reference, 'PURCHASE')` here must equal
 *    `buildEventId(...)` there, or the provider counts one sale twice and the
 *    merchant's bidding optimises against a number that is double the truth.
 *  - **The event vocabulary.** A provider that receives `Purchase` when it
 *    expects `CompletePayment` records a custom event no campaign optimises
 *    against — which looks like it is working, in the dashboard, while doing
 *    nothing.
 *
 * Hand-copying either into vanilla JS gives both a chance to drift silently.
 *
 * **What is deliberately not here:** advanced matching. The provider SDKs accept
 * plaintext email and phone and hash them in the browser, but the server already
 * sends those fields hashed, from data it holds anyway. Putting a shopper's
 * email into a third-party tag on the merchant's storefront to duplicate a match
 * that already happened is a privacy cost with no matching benefit.
 */

import {
  PROVIDER_EVENT_NAMES,
  pixelEventId,
  type PixelEventName,
  type PixelProvider,
  type StorefrontPixel,
} from '@codflow/shared';

/** The slice of the app embed's page context this module needs. */
export interface PixelPageContext {
  shop: { domain: string; currency: string; locale: string };
  page: { type: string; designMode: boolean };
  product: { id: string | number; variantId: string | number; title: string; price: number };
}

/** One event, already resolved to the values every provider will be given. */
export interface ClientPixelEvent {
  readonly name: PixelEventName;
  /** Shared with the server for order-linked events; page-local otherwise. */
  readonly eventId: string;
  readonly value: number | null;
  readonly currency: string | null;
  readonly orderReference: string | null;
  readonly contentIds: readonly string[];
  readonly contentName: string | null;
  readonly quantity: number;
}

export interface PixelInitOptions {
  readonly pixels: readonly StorefrontPixel[];
  readonly context: PixelPageContext;
}

/**
 * Whether a provider's SDK can address one tag out of several.
 *
 * Meta (`trackSingle`), TikTok (`instance`) and Google (`send_to`) can. Snapchat
 * and Pinterest cannot — their `track` goes to every tag the page has
 * initialised. So for those two, two tags of the same provider with different
 * `enabledEvents` cannot be told apart, and firing once per *provider* is the
 * only option that does not send the same event twice.
 */
const ADDRESSABLE: Readonly<Record<PixelProvider, boolean>> = {
  META: true,
  TIKTOK: true,
  GOOGLE_ADS: true,
  SNAPCHAT: false,
  PINTEREST: false,
  CUSTOM: false,
};

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Reads Shopify's own customer privacy decision.
 *
 * The app never asks for consent itself — the merchant's banner already did.
 * An unavailable API means no recorded decision, and no decision is not consent.
 */
export function marketingConsentGranted(): boolean {
  const privacy = (
    window as unknown as {
      Shopify?: { customerPrivacy?: { currentVisitorConsent?: () => Record<string, string> } };
    }
  ).Shopify?.customerPrivacy;

  try {
    return privacy?.currentVisitorConsent?.().marketing === 'yes';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type Eligibility = 'send' | 'no-consent' | 'not-enabled' | 'unsupported';

/**
 * The client-side mirror of the dispatcher's three gates, in the same order.
 *
 * Kept as a pure function so the gating can be tested without a DOM full of
 * third-party script tags.
 */
export function eligibility(
  pixel: StorefrontPixel,
  eventName: PixelEventName,
  consentGranted: boolean,
): Eligibility {
  if (pixel.requireConsent && !consentGranted) return 'no-consent';

  // An empty list means "every event this provider supports", matching the
  // server's rule exactly — a mismatch here would mean the browser and the
  // server disagree about which events exist, and only one of them would dedupe.
  if (pixel.enabledEvents.length > 0 && !pixel.enabledEvents.includes(eventName)) {
    return 'not-enabled';
  }

  if (!PROVIDER_EVENT_NAMES[pixel.provider][eventName]) return 'unsupported';

  return 'send';
}

/** The provider's own name for an event, or null when it has no equivalent. */
export function providerEventName(
  provider: PixelProvider,
  eventName: PixelEventName,
): string | null {
  return PROVIDER_EVENT_NAMES[provider][eventName] ?? null;
}

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

const injected = new Set<string>();

/**
 * Appends a third-party tag once.
 *
 * `async` on every one of them: a synchronous ad-platform script blocks parsing
 * of the merchant's own page, and no conversion event is worth a slower
 * storefront.
 */
function injectScript(src: string): void {
  if (injected.has(src)) return;
  injected.add(src);

  const script = document.createElement('script');
  script.async = true;
  script.src = src;

  const first = document.getElementsByTagName('script')[0];
  if (first?.parentNode) first.parentNode.insertBefore(script, first);
  else document.head.appendChild(script);
}

/** Narrow `window` to an indexable object without reaching for `any`. */
function globals(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

type Queue = unknown[] & Record<string, unknown>;

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

type FbqFunction = ((...args: unknown[]) => void) & Record<string, unknown>;

function loadMeta(pixelId: string): void {
  const w = globals();

  if (!w.fbq) {
    // Meta's own stub, transcribed. It exists so calls made before
    // `fbevents.js` arrives are queued rather than thrown away — which is the
    // common case, since we fire PageView immediately after injecting it.
    const fbq = function (this: unknown, ...args: unknown[]): void {
      const self = fbq as FbqFunction;
      if (typeof self.callMethod === 'function') {
        (self.callMethod as (...a: unknown[]) => void).apply(self, args);
      } else {
        (self.queue as unknown[]).push(args);
      }
    } as FbqFunction;

    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];

    w.fbq = fbq;
    w._fbq = fbq;

    injectScript('https://connect.facebook.net/en_US/fbevents.js');
  }

  (w.fbq as FbqFunction)('init', pixelId);
}

function trackMeta(pixelId: string, name: string, event: ClientPixelEvent): void {
  const parameters: Record<string, unknown> = {};

  if (event.value !== null) parameters.value = event.value;
  if (event.currency) parameters.currency = event.currency;
  if (event.contentIds.length > 0) {
    parameters.content_ids = event.contentIds;
    parameters.content_type = 'product';
  }
  if (event.contentName) parameters.content_name = event.contentName;
  if (event.orderReference) parameters.order_id = event.orderReference;

  // `trackSingle` rather than `track`: a merchant running two Meta pixels would
  // otherwise get every event on both, and `enabledEvents` would mean nothing.
  // `eventID` is the whole point of this file — it is what lets Meta discard the
  // server's copy of a Purchase it has already counted.
  (globals().fbq as FbqFunction)('trackSingle', pixelId, name, parameters, {
    eventID: event.eventId,
  });
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

const TIKTOK_METHODS = [
  'page',
  'track',
  'identify',
  'instances',
  'debug',
  'on',
  'off',
  'once',
  'ready',
  'alias',
  'group',
  'enableCookie',
  'disableCookie',
];

/** Queues a call on TikTok's array-shaped stub, the way their SDK drains it. */
function deferTikTokMethods(target: Queue): Queue {
  for (const method of TIKTOK_METHODS) {
    target[method] = function (...args: unknown[]): void {
      target.push([method, ...args]);
    };
  }
  return target;
}

function loadTikTok(pixelId: string): void {
  const w = globals();
  w.TiktokAnalyticsObject = 'ttq';

  let ttq = w.ttq as Queue | undefined;

  if (!ttq) {
    ttq = deferTikTokMethods([] as unknown as Queue);
    ttq._i = {};
    ttq._t = {};
    ttq._o = {};
    ttq.instance = function (id: string): Queue {
      const store = ttq?._i as Record<string, Queue>;
      return store[id] ?? deferTikTokMethods([] as unknown as Queue);
    };
    w.ttq = ttq;
  }

  const instances = ttq._i as Record<string, Queue>;
  if (instances[pixelId]) return;

  const url = 'https://analytics.tiktok.com/i18n/pixel/events.js';

  instances[pixelId] = deferTikTokMethods([] as unknown as Queue);
  instances[pixelId]._u = url;
  (ttq._t as Record<string, number>)[pixelId] = Date.now();
  (ttq._o as Record<string, unknown>)[pixelId] = {};

  injectScript(`${url}?sdkid=${encodeURIComponent(pixelId)}&lib=ttq`);
}

function trackTikTok(pixelId: string, name: string, event: ClientPixelEvent): void {
  const ttq = globals().ttq as Queue | undefined;
  if (!ttq) return;

  const instance = (ttq._i as Record<string, Queue>)[pixelId] ?? ttq;

  // TikTok's page event has a dedicated call rather than a tracked name.
  if (event.name === 'PAGE_VIEW') {
    (instance.page as () => void)();
    return;
  }

  const properties: Record<string, unknown> = {};

  if (event.value !== null) properties.value = event.value;
  if (event.currency) properties.currency = event.currency;
  if (event.contentIds.length > 0) {
    properties.contents = event.contentIds.map((id) => ({
      content_id: id,
      content_type: 'product',
      content_name: event.contentName ?? undefined,
      quantity: event.quantity,
    }));
  }
  if (event.orderReference) properties.order_id = event.orderReference;

  (instance.track as (n: string, p: unknown, o: unknown) => void)(name, properties, {
    event_id: event.eventId,
  });
}

// ---------------------------------------------------------------------------
// Snapchat
// ---------------------------------------------------------------------------

function loadSnapchat(pixelId: string): void {
  const w = globals();

  if (!w.snaptr) {
    const snaptr = function (...args: unknown[]): void {
      const self = snaptr as FbqFunction;
      if (typeof self.handleRequest === 'function') {
        (self.handleRequest as (...a: unknown[]) => void).apply(self, args);
      } else {
        (self.queue as unknown[]).push(args);
      }
    } as FbqFunction;

    snaptr.queue = [];
    w.snaptr = snaptr;

    injectScript('https://sc-static.net/scevent.min.js');
  }

  (w.snaptr as FbqFunction)('init', pixelId);
}

function trackSnapchat(name: string, event: ClientPixelEvent): void {
  const parameters: Record<string, unknown> = {};

  if (event.value !== null) parameters.price = event.value;
  if (event.currency) parameters.currency = event.currency;
  if (event.contentIds.length > 0) parameters.item_ids = event.contentIds;
  if (event.orderReference) parameters.transaction_id = event.orderReference;

  // Snap's deduplication key has its own name; passing `event_id` instead is
  // accepted and silently ignored, which is the worst kind of wrong.
  parameters.client_dedup_id = event.eventId;

  (globals().snaptr as FbqFunction)('track', name, parameters);
}

// ---------------------------------------------------------------------------
// Pinterest
// ---------------------------------------------------------------------------

function loadPinterest(tagId: string): void {
  const w = globals();

  if (!w.pintrk) {
    const pintrk = function (...args: unknown[]): void {
      ((pintrk as FbqFunction).queue as unknown[]).push(args);
    } as FbqFunction;

    pintrk.queue = [];
    pintrk.version = '3.0';
    w.pintrk = pintrk;

    injectScript('https://s.pinimg.com/ct/core.js');
  }

  (w.pintrk as FbqFunction)('load', tagId);
}

function trackPinterest(name: string, event: ClientPixelEvent): void {
  const pintrk = globals().pintrk as FbqFunction;

  if (event.name === 'PAGE_VIEW') {
    pintrk('page');
    return;
  }

  const parameters: Record<string, unknown> = { event_id: event.eventId };

  if (event.value !== null) parameters.value = event.value;
  if (event.currency) parameters.currency = event.currency;
  if (event.contentIds.length > 0) {
    parameters.line_items = event.contentIds.map((id) => ({
      product_id: id,
      product_name: event.contentName ?? undefined,
      product_quantity: event.quantity,
    }));
  }
  if (event.orderReference) parameters.order_id = event.orderReference;

  pintrk('track', name, parameters);
}

// ---------------------------------------------------------------------------
// Google Ads
// ---------------------------------------------------------------------------

/**
 * The account this tag belongs to.
 *
 * Google Ads identifies the *account* (`AW-…`) and then a conversion *action*
 * within it (the label). `conversionId` is where the admin stores the former;
 * `pixelId` is the fallback for a merchant who pasted the `AW-…` there instead,
 * which is a mistake worth surviving rather than silently dropping every event.
 */
function googleAccountId(pixel: StorefrontPixel): string {
  return pixel.conversionId ?? pixel.pixelId;
}

function loadGoogle(pixel: StorefrontPixel): void {
  const w = globals();

  if (!w.dataLayer) w.dataLayer = [];
  if (!w.gtag) {
    // gtag must push `arguments` itself, not an array copy — the tag reads the
    // arguments object's shape.
    w.gtag = function (...args: unknown[]): void {
      (w.dataLayer as unknown[]).push(args);
    };
  }

  const gtag = w.gtag as (...args: unknown[]) => void;

  if (pixel.gtmContainerId) {
    // A merchant using Tag Manager has their conversion configured there; the
    // container decides what to do with the event. Loading gtag.js as well
    // would give them two tags racing to report the same conversion.
    injectScript(
      `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(pixel.gtmContainerId)}`,
    );
    (w.dataLayer as unknown[]).push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    return;
  }

  const account = googleAccountId(pixel);
  injectScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(account)}`);
  gtag('js', new Date());
  gtag('config', account);
}

function trackGoogle(pixel: StorefrontPixel, event: ClientPixelEvent): void {
  const w = globals();
  const account = googleAccountId(pixel);

  const payload: Record<string, unknown> = {
    // `transaction_id` is Google's deduplication key. It has to be the shared
    // event id and not the order reference, or a shop reporting both Purchase
    // and Lead for one order would have the second silently discarded as a
    // duplicate of the first.
    transaction_id: event.eventId,
  };

  if (event.value !== null) payload.value = event.value;
  if (event.currency) payload.currency = event.currency;

  if (pixel.gtmContainerId) {
    (w.dataLayer as unknown[]).push({
      event: `codflow_${event.name.toLowerCase()}`,
      ...payload,
      order_reference: event.orderReference,
    });
    return;
  }

  // Without a label there is no conversion action to report against, and
  // Google records nothing. Say so in the theme editor rather than failing mute.
  if (!pixel.conversionLabel) {
    log(`Google Ads pixel ${account} has no conversion label — ${event.name} not sent`);
    return;
  }

  payload.send_to = `${account}/${pixel.conversionLabel}`;
  (w.gtag as (...args: unknown[]) => void)('event', 'conversion', payload);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

let state: {
  pixels: readonly StorefrontPixel[];
  context: PixelPageContext;
} | null = null;

/** True once the storefront listeners are attached. Never reset. */
let listening = false;

/** Events already sent this page view, so a re-open cannot double-report. */
const sent = new Set<string>();

/** Events held back because consent had not been given when they happened. */
const deferred: ClientPixelEvent[] = [];

function log(message: string, detail?: unknown): void {
  // Design mode only, matching codflow.js: a storefront console belongs to the
  // merchant's theme developer.
  if (!state?.context.page.designMode) return;
  /* eslint-disable-next-line no-console */
  console.info('[CODkar pixels] ' + message, detail === undefined ? '' : detail);
}

/**
 * The key a given pixel and event dedupe against *within this page*.
 *
 * Per tag where the SDK can address one tag; per provider where it cannot, so
 * two Pinterest tags do not each cause a `pintrk('track')` that both of them
 * would receive.
 */
function sentKey(pixel: StorefrontPixel, event: ClientPixelEvent): string {
  return ADDRESSABLE[pixel.provider]
    ? `${pixel.provider}:${pixel.pixelId}:${event.eventId}`
    : `${pixel.provider}:${event.eventId}`;
}

const loaded = new Set<string>();

function ensureLoaded(pixel: StorefrontPixel): void {
  const key = `${pixel.provider}:${pixel.pixelId}`;
  if (loaded.has(key)) return;
  loaded.add(key);

  switch (pixel.provider) {
    case 'META':
      loadMeta(pixel.pixelId);
      break;
    case 'TIKTOK':
      loadTikTok(pixel.pixelId);
      break;
    case 'SNAPCHAT':
      loadSnapchat(pixel.pixelId);
      break;
    case 'PINTEREST':
      loadPinterest(pixel.pixelId);
      break;
    case 'GOOGLE_ADS':
      loadGoogle(pixel);
      break;
    default:
      break;
  }
}

function send(pixel: StorefrontPixel, event: ClientPixelEvent): void {
  const name = providerEventName(pixel.provider, event.name);
  if (!name) return;

  ensureLoaded(pixel);

  try {
    switch (pixel.provider) {
      case 'META':
        trackMeta(pixel.pixelId, name, event);
        break;
      case 'TIKTOK':
        trackTikTok(pixel.pixelId, name, event);
        break;
      case 'SNAPCHAT':
        trackSnapchat(name, event);
        break;
      case 'PINTEREST':
        trackPinterest(name, event);
        break;
      case 'GOOGLE_ADS':
        trackGoogle(pixel, event);
        break;
      default:
        break;
    }

    log(`${pixel.provider} ${event.name} sent as ${name}`, event.eventId);
  } catch (error) {
    // A broken third-party tag must not stop the remaining pixels, and must
    // never surface to the shopper — they are in the middle of buying.
    log(`${pixel.provider} ${event.name} threw`, error);
  }
}

/**
 * Fires one event across every eligible pixel.
 *
 * Exported so `codflow.js` and the tests can raise events without knowing which
 * providers are configured.
 */
export function emit(event: ClientPixelEvent): void {
  if (!state) return;

  const consent = marketingConsentGranted();
  let held = false;

  for (const pixel of state.pixels) {
    const key = sentKey(pixel, event);
    if (sent.has(key)) continue;

    const verdict = eligibility(pixel, event.name, consent);

    if (verdict === 'no-consent') {
      // Held rather than dropped: a shopper who accepts the banner after
      // landing has consented to the page view they are still looking at.
      held = true;
      continue;
    }

    if (verdict !== 'send') {
      log(`${pixel.provider} ${event.name} skipped: ${verdict}`);
      continue;
    }

    sent.add(key);
    send(pixel, event);
  }

  if (held && !deferred.some((queued) => queued.eventId === event.eventId)) {
    deferred.push(event);
  }
}

/** Replays events that were waiting on consent, once it is given. */
function flushDeferred(): void {
  if (!marketingConsentGranted()) return;

  const pending = deferred.splice(0, deferred.length);
  for (const event of pending) emit(event);
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

/**
 * A page-local id for events that no server event will ever pair with.
 *
 * PAGE_VIEW, VIEW_CONTENT and INITIATE_CHECKOUT are browser-only — the server
 * dispatches PURCHASE and nothing else — so their ids only need to be unique,
 * not reproducible. Deriving them from the page rather than randomly also makes
 * them idempotent: a theme re-rendering its section cannot double-count a view.
 */
function pageEventId(name: PixelEventName, context: PixelPageContext): string {
  const page = `${context.page.type}:${context.product.id || '-'}`;
  return `codflow-${page}-${name}`.toLowerCase();
}

function productIds(context: PixelPageContext): string[] {
  const id = context.product.variantId || context.product.id;
  return id ? [String(id)] : [];
}

function pageEvent(name: PixelEventName, context: PixelPageContext): ClientPixelEvent {
  return {
    name,
    eventId: pageEventId(name, context),
    // No value on a browse event: a ViewContent worth the product's price makes
    // browsing look as profitable as buying, and the merchant bids on it.
    value: null,
    currency: null,
    orderReference: null,
    contentIds: productIds(context),
    contentName: context.product.title || null,
    quantity: 1,
  };
}

/**
 * The Purchase event, and the only one whose id has to match the server's.
 *
 * It fires when the shopper sees their confirmation, while the server's fires
 * only after the order reaches Shopify. Both are correct for their own vantage
 * point, and whichever arrives first is the one the provider keeps — that is
 * what the shared id buys. Sending only from the server would lose every
 * conversion the browser could still have reported after a push failure; not
 * sending from the server would lose every one an ad blocker suppressed.
 */
export function purchaseEvent(
  reference: string,
  total: string,
  context: PixelPageContext,
): ClientPixelEvent {
  const value = Number(total);

  return {
    name: 'PURCHASE',
    eventId: pixelEventId(reference, 'PURCHASE'),
    value: Number.isFinite(value) ? value : null,
    currency: context.shop.currency,
    orderReference: reference,
    contentIds: productIds(context),
    contentName: context.product.title || null,
    quantity: 1,
  };
}

// ---------------------------------------------------------------------------
// Entry point, called by codflow.js
// ---------------------------------------------------------------------------

/**
 * Wires the storefront's own events to the configured pixels.
 *
 * `codflow.js` dispatches `codflow:form:open` and `codflow:order:created` on
 * `document` and also records them on a queue, because this bundle is fetched
 * asynchronously and a shopper who submits before it arrives would otherwise
 * have their conversion go unreported.
 */
export function init(options: PixelInitOptions): void {
  if (state) return;

  state = { pixels: options.pixels, context: options.context };

  if (options.pixels.length === 0) return;

  // Attached once for the life of the page, and reading `state` rather than
  // closing over this call's options: `init` is idempotent above, but a listener
  // holding a stale context would outlive the state it belonged to.
  if (!listening) {
    listening = true;

    document.addEventListener('codflow:form:open', () => {
      if (state) emit(pageEvent('INITIATE_CHECKOUT', state.context));
    });

    document.addEventListener('codflow:order:created', (event) => {
      const detail = (event as CustomEvent<{ reference?: string; total?: string }>).detail;
      if (!state || !detail?.reference) return;

      emit(purchaseEvent(detail.reference, detail.total ?? '0', state.context));
    });

    // Shopify raises this when the shopper answers the merchant's banner.
    document.addEventListener('visitorConsentCollected', flushDeferred);
  }

  emit(pageEvent('PAGE_VIEW', options.context));

  if (options.context.page.type === 'product') {
    emit(pageEvent('VIEW_CONTENT', options.context));
  }

  // Anything that happened while this file was in flight. Replayed as real
  // events so the listeners above are the only place that knows what to do with
  // them, then the array is swapped for a sink: from here on the storefront's
  // own `document` dispatch arrives directly, and an array nobody drains again
  // would grow for the life of the page.
  const host = window as unknown as {
    CodFlowPixelQueue?: QueuedEvent[] | { push(entry: QueuedEvent): unknown };
  };

  const queued = host.CodFlowPixelQueue;

  if (Array.isArray(queued)) {
    for (const entry of queued.splice(0, queued.length)) {
      document.dispatchEvent(new CustomEvent(entry.name, { detail: entry.detail }));
    }
  }

  host.CodFlowPixelQueue = { push: () => 0 };
}

interface QueuedEvent {
  readonly name: string;
  readonly detail?: unknown;
}

/** Test seam: drops all module state so each case starts from nothing. */
export function reset(): void {
  state = null;
  sent.clear();
  loaded.clear();
  injected.clear();
  deferred.length = 0;
  delete (window as unknown as { CodFlowPixelQueue?: unknown }).CodFlowPixelQueue;
}

// Published for `codflow.js`, which loads this bundle lazily and has no module
// system of its own to import through.
(window as unknown as { CodFlowPixels: { init: typeof init } }).CodFlowPixels = { init };

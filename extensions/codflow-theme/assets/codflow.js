/*
 * CodFlow — storefront runtime.
 *
 * Loaded on every page of a store that has the app embed switched on. It
 * renders COD buttons and owns the dialog the COD form lives in.
 *
 * Constraints this file is written against, all of which are non-negotiable:
 *
 *  - **No build step and no dependencies.** Theme app extension assets are
 *    served verbatim; there is no bundler between this file and the shopper.
 *    So: one IIFE, ES2019-level syntax, no imports.
 *  - **No Liquid.** Shopify does not render Liquid in `assets/`, so nothing
 *    here can read shop or product data directly. Page context arrives through
 *    the JSON block the app embed writes; merchant configuration arrives from
 *    the API.
 *  - **It runs inside someone else's page.** Every global is namespaced, every
 *    listener is removable, and nothing assumes a particular theme's markup.
 *    A theme that re-renders a section must not leave duplicate buttons behind.
 *  - **It must never break the storefront.** Any failure path ends with the
 *    native buy buttons visible and working. A COD app that hides Add to Cart
 *    and then fails to render its own button has taken the store offline.
 */

(function () {
  'use strict';

  /* Captured at parse time, before anything else runs. `document.currentScript`
   * is only non-null while a script is executing synchronously, so it cannot be
   * read later from inside a callback — and it is the only way this file can
   * discover its own CDN URL. Shopify serves theme extension assets from a
   * versioned, uuid-bearing path that Liquid never exposes to JavaScript, so
   * deriving the sibling bundle's URL from here is the only reliable route. */
  var SCRIPT_URL = document.currentScript ? document.currentScript.src : '';

  /* Guard against double execution: the app embed and the app block both
   * declare this asset, and while Shopify normally dedupes, a theme that
   * re-renders a section through the Section Rendering API can re-run it. */
  if (window.__codflowLoaded) return;
  window.__codflowLoaded = true;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /* Must match `[app_proxy]` in shopify.app.toml (`prefix` + `subpath`).
   * Changing it there without changing it here silently 404s every request. */
  var PROXY_BASE = '/apps/codflow';

  var CACHE_PREFIX = 'codflow:config:';
  /* Short enough that a merchant editing settings sees the change on their next
   * page view rather than at the end of the session. */
  var CACHE_TTL_MS = 5 * 60 * 1000;

  var SELECTORS = {
    context: '[data-codflow-context]',
    root: '[data-codflow-root]',
    slot: '[data-codflow-slot]',
    button: '[data-codflow-button]'
  };

  /* Themes vary enormously, so native buy buttons are matched by a list of
   * conventions rather than one selector. Over-matching is the safer error:
   * a missed button leaves both options visible, which is merely untidy, while
   * hiding the wrong element could remove a shopper's only way to buy. */
  var NATIVE_BUY_SELECTORS = [
    'form[action*="/cart/add"] [type="submit"]',
    'form[action*="/cart/add"] .product-form__submit',
    '.shopify-payment-button',
    '.product-form__buttons .btn--add-to-cart',
    '[data-testid="Checkout-button"]'
  ];

  var FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]),' +
    'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /* Whether the theme editor is what is rendering us.
   *
   * Read from Shopify's own global rather than from page context, because the
   * most important thing to report — "there is no page context" — happens
   * before any context exists. Keying the logger on context alone meant the one
   * failure a merchant most needs explained was the one that printed nothing. */
  function inDesignMode() {
    if (state.context && state.context.page && state.context.page.designMode) return true;
    return Boolean(window.Shopify && window.Shopify.designMode);
  }

  function log(message, detail) {
    /* Only in the theme editor. A storefront console belongs to the merchant's
     * theme developer, and an app filling it with chatter makes their job
     * harder — but during design mode this is exactly what they need. */
    if (inDesignMode()) {
      /* eslint-disable-next-line no-console */
      console.info('[CodFlow] ' + message, detail === undefined ? '' : detail);
    }
  }

  function qsa(selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  }

  /* Escapes text destined for innerHTML. Merchant-authored labels arrive from
   * the API and are rendered into the page; a merchant is not an attacker, but
   * a label is still untrusted input crossing into markup, and treating it as
   * such costs nothing. */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * A GET that survives the storefront it runs in.
   *
   * Uses `XMLHttpRequest` rather than `fetch`, which is the opposite of what
   * this file would otherwise do, for a measured reason: Shopify's Web Pixels
   * Manager replaces `window.fetch` on every storefront, and that wrapper
   * intermittently never settles for app-proxy requests. Because the config
   * fetch is what gates rendering, a hung promise meant the COD button silently
   * never appeared — on some page loads and not others, with nothing in the
   * console. XHR is not instrumented by it and answered every time.
   *
   * The timeout is the more important half. Whatever transport is used, a
   * request that never settles must not leave the runtime waiting forever; the
   * caller treats a timeout the same as a failure and falls back to the
   * storefront's own buy buttons.
   */
  function requestJson(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();

      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.timeout = timeoutMs || 10000;

      xhr.onload = function () {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('Request failed: ' + xhr.status));
          return;
        }

        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (error) {
          reject(new Error('Response was not JSON'));
        }
      };

      xhr.onerror = function () {
        reject(new Error('Network error'));
      };

      xhr.ontimeout = function () {
        reject(new Error('Request timed out after ' + xhr.timeout + 'ms'));
      };

      xhr.send();
    });
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        fn.apply(self, args);
      }, wait);
    };
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = {
    context: null,
    config: null,
    dialogOpen: false,
    /* Element focus returns to when the dialog closes. Losing this is the most
     * common accessibility failure in modal dialogs — a keyboard user is
     * dumped back at the top of the document. */
    lastFocused: null,
    scrollListenerAttached: false,
    injected: {}
  };

  // ---------------------------------------------------------------------------
  // Page context
  // ---------------------------------------------------------------------------

  function readContext() {
    var node = document.querySelector(SELECTORS.context);

    if (!node) {
      /* The app embed is off for this theme.
       *
       * Silent on a live storefront — the merchant has simply not switched the
       * app on, and a shopper's console is not the place to say so. Loud in the
       * theme editor, because this is the single most common reason a merchant
       * reports "the button never appears": the app *block* loads this file on
       * its own, so everything looks wired up, but without the embed there is no
       * shop domain, no product and no configuration to render from.
       *
       * App embeds are per-theme and must be saved. Enabling one on the live
       * theme does not enable it on the development theme the CLI previews. */
      log(
        'The CodFlow app embed is not enabled on this theme. ' +
          'Theme editor → App embeds → turn on "CodFlow — Cash on Delivery", then Save.',
      );
      return null;
    }

    try {
      var parsed = JSON.parse(node.textContent);

      /* Defensive defaults. The app embed always writes every branch, but a
       * merchant can be running a cached copy of an older extension version
       * while the API already serves the newer config — and a missing property
       * here would throw inside a render path that lives in someone else's
       * storefront. Cheaper to normalise than to guard at every read. */
      parsed.shop = parsed.shop || {};
      parsed.page = parsed.page || {};
      parsed.product = parsed.product || {};
      parsed.cart = parsed.cart || {};
      parsed.customer = parsed.customer || {};
      parsed.theme = parsed.theme || {};
      parsed.strings = parsed.strings || {};

      if (!parsed.shop.domain) {
        log('Page context is missing the shop domain');
        return null;
      }

      return parsed;
    } catch (error) {
      log('Could not parse page context', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  function cacheKey() {
    var productId = (state.context.product && state.context.product.id) || '-';
    return CACHE_PREFIX + state.context.shop.domain + ':' + productId;
  }

  function readCachedConfig() {
    try {
      var raw = window.sessionStorage.getItem(cacheKey());
      if (!raw) return null;

      var entry = JSON.parse(raw);
      if (!entry || typeof entry.at !== 'number') return null;
      if (Date.now() - entry.at > CACHE_TTL_MS) return null;

      return entry.config;
    } catch (error) {
      /* Safari in private mode throws on sessionStorage access. Treat any
       * storage failure as a cache miss rather than letting it break the page. */
      return null;
    }
  }

  function writeCachedConfig(config) {
    try {
      window.sessionStorage.setItem(
        cacheKey(),
        JSON.stringify({ at: Date.now(), config: config })
      );
    } catch (error) {
      /* Quota exceeded or storage disabled. The config still works for this
       * page view; only the next one pays for another fetch. */
    }
  }

  function fetchConfig() {
    var params = new URLSearchParams();
    params.set('shop', state.context.shop.domain);

    if (state.context.product && state.context.product.id) {
      params.set('productId', String(state.context.product.id));
    }

    /* Same-origin through the proxy. The endpoint is deliberately
     * credential-free — it is a cacheable public response and sending cookies
     * would tie it to an individual shopper — and XHR does not attach them
     * cross-origin by default, so nothing extra is needed to keep that true. */
    return requestJson(PROXY_BASE + '/config?' + params.toString(), 10000).then(function (body) {
      return body && body.data ? body.data : null;
    });
  }

  function loadConfig() {
    var cached = readCachedConfig();

    if (cached) {
      log('Config served from sessionStorage');
      return Promise.resolve(cached);
    }

    return fetchConfig()
      .then(function (config) {
        if (config) writeCachedConfig(config);
        return config;
      })
      .catch(function (error) {
        log('Config request failed', error);
        /* Null means "behave as if COD is off". The native buy buttons are
         * never hidden before a config arrives, so the storefront is already in
         * its correct fallback state. */
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // Button rendering
  // ---------------------------------------------------------------------------

  function buttonForPlacement(placement) {
    if (!state.config || !state.config.buttons) return null;

    for (var i = 0; i < state.config.buttons.length; i += 1) {
      if (state.config.buttons[i].placement === placement) return state.config.buttons[i];
    }

    return null;
  }

  /* Inline styles rather than a class per button: the merchant's colours come
   * from the API at runtime, and a stylesheet in `assets/` is static. Custom
   * properties keep the CSS file in charge of layout while the API drives only
   * the values. */
  function buttonStyle(button) {
    return [
      '--codflow-bg:' + button.bgColor,
      '--codflow-fg:' + button.textColor,
      '--codflow-border:' + button.borderColor,
      '--codflow-radius:' + button.borderRadius + 'px',
      '--codflow-font-size:' + button.fontSize + 'px',
      '--codflow-font-weight:' + button.fontWeight,
      '--codflow-pad-y:' + button.paddingY + 'px',
      '--codflow-pad-x:' + button.paddingX + 'px',
      '--codflow-width:' + (button.fullWidth ? '100%' : 'auto')
    ].join(';');
  }

  function buildButton(button, placement) {
    var element = document.createElement('button');

    element.type = 'button';
    element.className =
      'codflow-button codflow-button--' +
      placement.toLowerCase().replace(/_/g, '-') +
      (button.animation && button.animation !== 'none'
        ? ' codflow-button--anim-' + button.animation
        : '');

    element.setAttribute('data-codflow-button', placement);
    element.setAttribute('style', buttonStyle(button));

    /* The dialog is created lazily, so `aria-controls` would point at nothing
     * until first open. `aria-haspopup` communicates the same intent without
     * referencing an element that may not exist. */
    element.setAttribute('aria-haspopup', 'dialog');
    element.setAttribute('aria-expanded', 'false');

    var markup = '<span class="codflow-button__label">' + escapeHtml(button.label) + '</span>';

    if (button.subLabel) {
      markup += '<span class="codflow-button__sublabel">' + escapeHtml(button.subLabel) + '</span>';
    }

    element.innerHTML = markup;
    element.addEventListener('click', onButtonClick);

    return element;
  }

  function isVisibleForViewport(button) {
    var isMobile = window.matchMedia('(max-width: 749px)').matches;
    return isMobile ? button.showOnMobile : button.showOnDesktop;
  }

  /* Fills the placeholders the app block rendered. Idempotent — a theme that
   * re-renders its section produces fresh empty slots, and slots already filled
   * are skipped rather than duplicated. */
  function renderSlots() {
    qsa(SELECTORS.slot).forEach(function (slot) {
      var placement = slot.getAttribute('data-codflow-placement');
      var button = buttonForPlacement(placement);

      if (!button || !isVisibleForViewport(button)) {
        slot.setAttribute('hidden', '');
        return;
      }

      if (slot.querySelector(SELECTORS.button)) return;

      slot.removeAttribute('hidden');
      slot.setAttribute('data-codflow-ready', 'true');

      var reserve = slot.querySelector('.codflow-slot__reserve');
      if (reserve) reserve.remove();

      var hint = slot.querySelector('[data-codflow-design-hint]');
      if (hint) hint.remove();

      slot.appendChild(buildButton(button, placement));
    });
  }

  /* Where a product-page button is placed when the merchant has not placed one
   * themselves. Ordered most specific first: a theme's own product form is the
   * right home, and the payment-button container is the fallback for themes
   * that render Buy Now outside the cart form. */
  var PRODUCT_ANCHORS = [
    'form[action*="/cart/add"] .product-form__buttons',
    'form[action*="/cart/add"]',
    '.product-form__buttons',
    '.shopify-payment-button',
    '[data-product-form]'
  ];

  /**
   * Places the product-page button when no app block provides a slot.
   *
   * Without this, switching the app embed on renders nothing at all: the embed
   * writes page context and the dialog root, but the *slot* a button renders
   * into comes from `cod-button.liquid`, which is an app block the merchant has
   * to drag into their product template themselves. A merchant who enables COD
   * and sees no button concludes the app is broken — and they are not wrong to.
   *
   * The merchant's own placement always wins. When a slot exists this does
   * nothing, so dragging the block in later moves the button rather than
   * producing a second one.
   */
  function autoPlaceProductButton() {
    var placement = 'PRODUCT_PAGE';
    var button = buttonForPlacement(placement);

    var existing = document.querySelector('[data-codflow-auto="' + placement + '"]');

    /* A slot rendered by the app block takes precedence. `renderSlots` runs
     * first, so by now the merchant's button is already in the DOM. */
    var placedByMerchant = qsa(SELECTORS.button).some(function (element) {
      return (
        element.getAttribute('data-codflow-button') === placement &&
        !element.closest('[data-codflow-auto]')
      );
    });

    if (!button || !isVisibleForViewport(button) || placedByMerchant) {
      if (existing) existing.remove();
      return;
    }

    /* Only on a product page: there is no variant to order anywhere else, and
     * the form needs one. */
    var isProductPage =
      (state.context.page && state.context.page.type === 'product') ||
      Boolean(state.context.product && state.context.product.id);

    if (!isProductPage) {
      if (existing) existing.remove();
      return;
    }

    if (existing) return;

    var selectors = state.context.theme.anchorSelector
      ? [state.context.theme.anchorSelector].concat(PRODUCT_ANCHORS)
      : PRODUCT_ANCHORS;

    var anchor = null;

    for (var i = 0; i < selectors.length && !anchor; i += 1) {
      try {
        anchor = document.querySelector(selectors[i]);
      } catch (error) {
        /* A merchant-supplied selector can be invalid. Their typo must not stop
         * the remaining fallbacks from being tried. */
        log('Invalid anchor selector: ' + selectors[i], error);
      }
    }

    if (!anchor) {
      log('No product form found — cannot place the COD button automatically');
      return;
    }

    var host = document.createElement('div');
    host.className = 'codflow-slot codflow-slot--auto';
    host.setAttribute('data-codflow-auto', placement);
    host.setAttribute('data-codflow-ready', 'true');
    host.appendChild(buildButton(button, placement));

    /* After the theme's buy buttons rather than before them: COD is an
     * alternative to checkout, and a shopper scanning the page should meet the
     * store's own primary action first unless the merchant has said otherwise
     * by placing the block deliberately. */
    if (anchor.parentNode) {
      anchor.parentNode.insertBefore(host, anchor.nextSibling);
    } else {
      anchor.appendChild(host);
    }

    log('COD button placed automatically', selectors);
  }

  /* Sticky and floating buttons have no home in any theme's template, so they
   * are appended to <body> and positioned by CSS. Injecting into the theme's
   * own markup instead would fight whatever layout the merchant is using. */
  function renderInjected(placement, themeToggle) {
    if (themeToggle === false) return;

    var button = buttonForPlacement(placement);
    var existing = state.injected[placement];

    if (!button || !isVisibleForViewport(button)) {
      if (existing) {
        existing.remove();
        state.injected[placement] = null;
      }
      return;
    }

    if (existing) return;

    var host = document.createElement('div');
    host.className = 'codflow-floating codflow-floating--' + placement.toLowerCase().replace(/_/g, '-');
    host.setAttribute('data-codflow-injected', placement);
    host.style.setProperty('--codflow-offset-bottom', button.stickyOffsetBottom + 'px');

    if (placement === 'FLOATING') {
      host.setAttribute('data-position', button.floatingPosition || 'bottom_right');
    }

    /* Hidden until the scroll threshold is met. Starting visible and hiding on
     * the first scroll event produces a flash on every page load. */
    if (button.showAfterScrollPx > 0) {
      host.setAttribute('data-codflow-await-scroll', String(button.showAfterScrollPx));
      host.setAttribute('hidden', '');
    }

    host.appendChild(buildButton(button, placement));
    document.body.appendChild(host);
    state.injected[placement] = host;
  }

  function evaluateScrollVisibility() {
    var scrolled = window.pageYOffset || document.documentElement.scrollTop || 0;

    qsa('[data-codflow-await-scroll]').forEach(function (host) {
      var threshold = parseInt(host.getAttribute('data-codflow-await-scroll'), 10) || 0;

      if (scrolled >= threshold) {
        host.removeAttribute('hidden');
      } else {
        host.setAttribute('hidden', '');
      }
    });
  }

  function attachScrollListener() {
    if (state.scrollListenerAttached) return;
    state.scrollListenerAttached = true;

    /* `passive` because this listener never calls preventDefault; without it
     * the browser cannot start scrolling until the handler returns, which is a
     * measurable jank source on mobile. */
    window.addEventListener('scroll', evaluateScrollVisibility, { passive: true });
    evaluateScrollVisibility();
  }

  // ---------------------------------------------------------------------------
  // Native buy buttons
  // ---------------------------------------------------------------------------

  /* Hides the theme's own buy buttons when the merchant has chosen to replace
   * them. Applied only after a COD button has actually rendered — hiding Add to
   * Cart and then failing to paint a replacement would leave the shopper with
   * no way to buy at all. */
  function applyNativeButtonPolicy() {
    if (!state.config || !state.config.enabled || !state.config.eligible) return;

    var replaceAddToCart = state.config.replaceAddToCart;
    var replaceBuyNow = state.config.replaceBuyNow;

    if (!replaceAddToCart && !replaceBuyNow) return;

    var rendered = document.querySelector(SELECTORS.button);
    if (!rendered) {
      log('Not hiding native buttons — no CodFlow button rendered');
      return;
    }

    var selectors = state.context.theme.hideNativeSelector
      ? [state.context.theme.hideNativeSelector]
      : NATIVE_BUY_SELECTORS;

    selectors.forEach(function (selector) {
      var isPaymentButton = selector.indexOf('shopify-payment-button') !== -1;

      if (isPaymentButton && !replaceBuyNow) return;
      if (!isPaymentButton && !replaceAddToCart) return;

      try {
        qsa(selector).forEach(function (element) {
          element.classList.add('codflow-hidden-native');
        });
      } catch (error) {
        /* A merchant-supplied selector can be invalid. Their typo must not
         * take down the rest of the runtime. */
        log('Invalid native-button selector: ' + selector, error);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Form bundle — loaded on demand
  // ---------------------------------------------------------------------------

  var formBundlePromise = null;

  /* Loads a sibling bundle from the same CDN directory this file was served
   * from. Shopify's asset URLs are versioned and uuid-bearing, and Liquid never
   * exposes them to JavaScript, so rewriting our own filename is the only way to
   * name a neighbour. `globalName` is what the bundle registers on `window`. */
  function loadSiblingBundle(filename, globalName) {
    return new Promise(function (resolve, reject) {
      if (window[globalName]) {
        resolve(window[globalName]);
        return;
      }

      if (!SCRIPT_URL) {
        reject(new Error('Cannot resolve the URL of ' + filename));
        return;
      }

      var script = document.createElement('script');
      script.src = SCRIPT_URL.replace(/codflow\.js(\?.*)?$/, filename);
      script.async = true;

      script.onload = function () {
        if (window[globalName]) resolve(window[globalName]);
        else reject(new Error(filename + ' loaded but did not register'));
      };

      script.onerror = function () {
        reject(new Error(filename + ' failed to load'));
      };

      document.head.appendChild(script);
    });
  }

  /**
   * Loads the COD form bundle the first time a shopper opens the dialog.
   *
   * Deferred rather than bundled into this file because the overwhelming
   * majority of product page views never open the form, and the renderer plus
   * the shared validation engine is roughly as large again as this file. Paying
   * for it on every page view to save a few hundred milliseconds on the few
   * that convert is the wrong trade.
   */
  function loadFormBundle() {
    if (formBundlePromise) return formBundlePromise;

    formBundlePromise = loadSiblingBundle('codflow-form.js', 'CodFlowForm').catch(function (error) {
      /* Allow a retry on the next open: a failed load is usually a transient
       * network blip, and permanently caching the rejection would leave the
       * shopper unable to order for the rest of their visit. */
      formBundlePromise = null;
      throw error;
    });

    return formBundlePromise;
  }

  // ---------------------------------------------------------------------------
  // Telemetry
  // ---------------------------------------------------------------------------

  var telemetrySent = {};

  /**
   * Reports a storefront event to the app's analytics.
   *
   * The conversion rate needs a denominator, and how many shoppers *saw* a COD
   * button is the one figure the app cannot derive from its own database. Either
   * this reports it or the dashboard can never answer the question a merchant
   * evaluating COD actually has.
   *
   * `sendBeacon` because most of these fire on paths where the page may be
   * leaving — a click that opens a dialog, a form submit. A `fetch` is
   * cancelled when the document unloads; a beacon is handed to the browser and
   * delivered regardless. The `fetch` fallback covers older browsers, with
   * `keepalive` for the same reason.
   *
   * Sent at most once per event per page view: a theme that re-renders its
   * product section would otherwise report a second view of the same page and
   * quietly deflate the merchant's conversion rate.
   */
  function reportTelemetry(event) {
    if (telemetrySent[event]) return;
    telemetrySent[event] = true;

    if (!state.context || !state.context.shop || !state.context.shop.domain) return;

    /* Nothing is reported in the theme editor. A merchant dragging blocks
     * around would otherwise generate views that no shopper ever had. */
    if (state.context.page && state.context.page.designMode) return;

    var url = PROXY_BASE + '/telemetry';
    var body = JSON.stringify({ shop: state.context.shop.domain, event: event });

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      }

      fetch(url, {
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: body
      }).catch(function () {
        /* Analytics must never surface on a storefront. */
      });
    } catch (error) {
      log('Telemetry failed', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Pixels — loaded on demand
  // ---------------------------------------------------------------------------

  /**
   * Records a storefront event for the pixel bundle.
   *
   * Every event is both dispatched on `document` — where a merchant's own theme
   * code can observe it — and pushed onto a queue. The queue exists because the
   * pixel bundle is fetched asynchronously: a shopper who opens the form and
   * submits it before the bundle arrives would otherwise have their conversion
   * go unreported, which is the one failure this whole feature exists to avoid.
   * The bundle drains the queue on init and dedupes against what it has already
   * sent, so an event that arrives by both routes is still reported once.
   */
  function emit(name, detail) {
    if (state.config && state.config.pixels && state.config.pixels.length > 0) {
      window.CodFlowPixelQueue = window.CodFlowPixelQueue || [];
      window.CodFlowPixelQueue.push({ name: name, detail: detail });
    }

    document.dispatchEvent(new CustomEvent(name, { detail: detail }));
  }

  /**
   * Loads and starts client-side pixel firing.
   *
   * Only when the merchant has configured at least one pixel: a shop with none
   * never pays for the request, and a shop with pixels is already loading third
   * party tags an order of magnitude larger than this bundle.
   *
   * Client-side events matter even though the server sends its own. A meaningful
   * share of storefront traffic never executes a third-party pixel — ad
   * blockers, ITP — and equally, a browser event is the only one that survives
   * a failed push to Shopify. The two halves share a deterministic event id, so
   * the provider counts whichever arrives first and discards the other.
   */
  function startPixels() {
    if (!state.config || !state.config.pixels || state.config.pixels.length === 0) return;

    loadSiblingBundle('codflow-pixels.js', 'CodFlowPixels')
      .then(function (bundle) {
        bundle.init({ pixels: state.config.pixels, context: state.context });
      })
      .catch(function (error) {
        /* Tracking is not the storefront. A bundle that fails to load costs the
         * merchant attribution on this page view and nothing else. */
        log('Pixel bundle failed to load', error);
      });
  }

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------

  function dialogRoot() {
    return document.querySelector(SELECTORS.root);
  }

  function buildDialog() {
    var root = dialogRoot();
    if (!root || root.getAttribute('data-codflow-built') === 'true') return root;

    root.setAttribute('data-codflow-built', 'true');
    root.className = 'codflow-overlay';
    root.innerHTML =
      '<div class="codflow-backdrop" data-codflow-backdrop></div>' +
      '<div class="codflow-dialog" role="dialog" aria-modal="true" ' +
      'aria-labelledby="codflow-dialog-title" tabindex="-1">' +
      '<button type="button" class="codflow-dialog__close" data-codflow-close ' +
      'aria-label="' + escapeHtml(state.context.strings.close) + '">&times;</button>' +
      '<h2 id="codflow-dialog-title" class="codflow-dialog__title"></h2>' +
      '<div class="codflow-dialog__body" data-codflow-body></div>' +
      '</div>';

    root.querySelector('[data-codflow-backdrop]').addEventListener('click', closeDialog);
    root.querySelector('[data-codflow-close]').addEventListener('click', closeDialog);

    return root;
  }

  /* Keeps Tab inside the dialog. Without this a keyboard user tabs straight out
   * into the page behind an `aria-modal` dialog, which is both confusing and a
   * WCAG failure. */
  function trapFocus(event) {
    if (event.key !== 'Tab' || !state.dialogOpen) return;

    var dialog = document.querySelector('.codflow-dialog');
    if (!dialog) return;

    var focusable = qsa(FOCUSABLE, dialog).filter(function (element) {
      return element.offsetParent !== null;
    });

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    var first = focusable[0];
    var last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && state.dialogOpen) {
      closeDialog();
      return;
    }
    trapFocus(event);
  }

  function openDialog(placement) {
    var root = buildDialog();
    if (!root) return;

    state.lastFocused = document.activeElement;
    state.dialogOpen = true;

    root.removeAttribute('hidden');
    root.setAttribute('data-codflow-placement', placement);
    document.documentElement.classList.add('codflow-scroll-locked');

    var title = root.querySelector('.codflow-dialog__title');
    var body = root.querySelector('[data-codflow-body]');

    /* Shown while the form bundle loads. On a repeat open both the bundle and
     * the form definition are already in memory, so this is invisible. */
    title.textContent = state.context.strings.openForm;
    body.innerHTML =
      '<p class="codflow-dialog__placeholder">' +
      escapeHtml(state.context.strings.loading) +
      '</p>';

    loadFormBundle()
      .then(function (bundle) {
        return bundle.mount({ root: root, context: state.context, config: state.config });
      })
      .catch(function (error) {
        log('Could not load the COD form', error);

        /* A failed load must not leave the shopper staring at a spinner. The
         * retry button re-runs the whole open, which re-attempts the bundle. */
        body.innerHTML =
          '<div class="codflow-form__error" role="alert">' +
          '<p>' + escapeHtml(state.context.strings.errorBody) + '</p>' +
          '<button type="button" class="codflow-submit" data-codflow-retry>' +
          escapeHtml(state.context.strings.retry) +
          '</button></div>';

        var retry = body.querySelector('[data-codflow-retry]');
        if (retry) {
          retry.addEventListener('click', function () {
            closeDialog();
            openDialog(placement);
          });
        }
      });

    document.addEventListener('keydown', onKeydown);

    qsa(SELECTORS.button).forEach(function (element) {
      element.setAttribute('aria-expanded', 'true');
    });

    root.querySelector('.codflow-dialog').focus();

    /* Lets the rest of the app — pixel tracking included — observe form opens
     * without this module knowing about them. */
    reportTelemetry('form_start');

    emit('codflow:form:open', {
      placement: placement,
      config: state.config,
      context: state.context
    });
  }

  function closeDialog() {
    var root = dialogRoot();
    if (!root || !state.dialogOpen) return;

    state.dialogOpen = false;
    root.setAttribute('hidden', '');
    document.documentElement.classList.remove('codflow-scroll-locked');
    document.removeEventListener('keydown', onKeydown);

    qsa(SELECTORS.button).forEach(function (element) {
      element.setAttribute('aria-expanded', 'false');
    });

    /* Returning focus is what makes the dialog usable with a keyboard or a
     * screen reader — without it the user is silently returned to the document
     * root and has to navigate back to where they were. */
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
      state.lastFocused.focus();
    }

    document.dispatchEvent(new CustomEvent('codflow:form:close'));
  }

  function onButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    var placement = event.currentTarget.getAttribute('data-codflow-button');

    reportTelemetry('button_click');
    openDialog(placement);
  }

  // ---------------------------------------------------------------------------
  // Rendering pipeline
  // ---------------------------------------------------------------------------

  function render() {
    if (!state.config || !state.config.enabled || !state.config.eligible) {
      /* Explicitly clear anything a previous render left behind: a variant
       * change can move a product from eligible to not. */
      Object.keys(state.injected).forEach(function (placement) {
        if (state.injected[placement]) {
          state.injected[placement].remove();
          state.injected[placement] = null;
        }
      });
      return;
    }

    applyBranding();
    renderSlots();
    autoPlaceProductButton();
    renderInjected('STICKY_MOBILE', state.context.theme.stickyMobile);
    renderInjected('FLOATING', state.context.theme.floating);
    attachScrollListener();
    applyNativeButtonPolicy();

    /* A view is reported once a button has actually rendered, not when the
     * config arrives. A shopper on a page where COD turned out to be
     * ineligible never saw the option, and counting them would understate the
     * conversion rate of the shoppers who did. */
    if (document.querySelector(SELECTORS.button)) {
      reportTelemetry('form_view');
    }
  }

  /* Publishes the merchant's brand values as custom properties on :root so the
   * static stylesheet can consume them. */
  function applyBranding() {
    var branding = state.config.branding;
    var root = document.documentElement;

    root.style.setProperty('--codflow-brand-primary', branding.primaryColor);
    root.style.setProperty('--codflow-brand-secondary', branding.secondaryColor);
    root.style.setProperty('--codflow-brand-text', branding.textColor);
    root.style.setProperty('--codflow-brand-font', branding.fontFamily);
    root.style.setProperty('--codflow-brand-radius', branding.borderRadius + 'px');

    if (state.config.localization.rtl) {
      root.setAttribute('data-codflow-dir', 'rtl');
    }

    if (branding.customCss && !document.getElementById('codflow-custom-css')) {
      /* Merchant-authored CSS, delivered only on plans that include it. Scoped
       * to a <style> element rather than injected inline so a syntax error
       * degrades that rule instead of breaking the element it was meant for. */
      var style = document.createElement('style');
      style.id = 'codflow-custom-css';
      style.textContent = branding.customCss;
      document.head.appendChild(style);
    }
  }

  // ---------------------------------------------------------------------------
  // Theme integration
  // ---------------------------------------------------------------------------

  var rerender = debounce(function () {
    state.context = readContext() || state.context;
    render();
  }, 100);

  function observeThemeChanges() {
    /* Themes re-render sections through the Section Rendering API on variant
     * change, cart updates and in the theme editor. Each of those replaces DOM
     * this runtime has already written to, so the slots have to be refilled. */
    document.addEventListener('shopify:section:load', rerender);
    document.addEventListener('shopify:section:unload', rerender);
    document.addEventListener('shopify:block:select', rerender);

    /* Variant pickers do not emit a standard event. A mutation observer scoped
     * to the product form catches the re-render regardless of how the theme
     * implements it, which is the only approach that works across themes. */
    var productForm = document.querySelector('form[action*="/cart/add"]');

    if (productForm && typeof window.MutationObserver === 'function') {
      new window.MutationObserver(rerender).observe(productForm, {
        childList: true,
        subtree: true
      });
    }

    /* Viewport crossing the mobile breakpoint changes which buttons apply. */
    window.addEventListener('resize', rerender, { passive: true });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  function boot() {
    state.context = readContext();

    if (!state.context) return;

    log('Booting', state.context.page);

    loadConfig().then(function (config) {
      state.config = config;

      if (!config || !config.enabled) {
        log('COD is not available for this shop');
        return;
      }

      /* Before `render`, and outside its eligibility check: a product excluded
       * from COD is still a page the merchant's pixels want to see. */
      startPixels();

      render();
      observeThemeChanges();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

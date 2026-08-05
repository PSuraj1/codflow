/**
 * App Bridge access.
 *
 * App Bridge 4 is loaded from Shopify's CDN by a script tag in `index.html`,
 * not bundled, so it arrives as a global rather than an import. That is a
 * requirement, not a convenience: Shopify auto-updates that file, and a
 * vendored copy goes stale in ways that break embedded features silently.
 *
 * The consequence is that TypeScript knows nothing about it, so the surface the
 * app actually uses is declared here and nowhere else. Everything else in the
 * admin goes through these functions instead of touching `window.shopify`.
 */

interface ShopifyGlobal {
  /**
   * Mints a session token for the current staff user.
   *
   * Tokens are short-lived (about a minute) and App Bridge caches and refreshes
   * them internally, so calling this before every request is the intended usage
   * — it is not a network round trip in the common case.
   */
  idToken: () => Promise<string>;
  config: {
    apiKey: string;
    shop?: string;
    host?: string;
    locale?: string;
  };
  /** Opens a URL. `_top` escapes the app iframe; `_self` navigates within it. */
  open?: (url: string, target?: string) => void;
  /**
   * The admin's own contextual save bar, shown above the app iframe.
   *
   * Addressed by the `id` of a `<ui-save-bar>` element rather than by passing
   * it content: the bar is rendered by the admin, outside this frame, so the
   * element in the app's DOM is a declaration of what it should contain rather
   * than the thing the merchant sees.
   */
  saveBar?: {
    show: (id: string) => Promise<void>;
    hide: (id: string) => Promise<void>;
  };
  /**
   * Shopify's own product and collection picker.
   *
   * Rendered by the admin, outside this frame, so it can search the merchant's
   * whole catalogue — something an app-side picker could only do by paginating
   * the Admin API and rebuilding a search box Shopify already ships.
   *
   * Resolves to the selection, or `undefined` when the merchant cancels.
   */
  resourcePicker?: (options: {
    type: 'product' | 'collection' | 'variant';
    multiple?: boolean;
    selectionIds?: { id: string }[];
  }) => Promise<{ id: string }[] | undefined>;
  toast?: {
    show: (message: string, options?: { isError?: boolean; duration?: number }) => void;
  };
}

declare global {
  interface Window {
    shopify?: ShopifyGlobal;
  }
}

export class AppBridgeUnavailableError extends Error {
  constructor() {
    super(
      'App Bridge is not available. This app must be opened from the Shopify admin — ' +
        'the CDN script in index.html only initialises inside the admin iframe.',
    );
    this.name = 'AppBridgeUnavailableError';
  }
}

export function getAppBridge(): ShopifyGlobal {
  const bridge = window.shopify;
  if (!bridge) throw new AppBridgeUnavailableError();
  return bridge;
}

/** True when the app is running embedded. False for a direct browser visit. */
export function isEmbedded(): boolean {
  return typeof window !== 'undefined' && Boolean(window.shopify) && window.top !== window.self;
}

/** Current session token, for the `Authorization` header. */
export async function getSessionToken(): Promise<string> {
  return getAppBridge().idToken();
}

/** The shop this app instance is running for, when App Bridge knows it. */
export function currentShop(): string | null {
  return window.shopify?.config.shop ?? null;
}

/**
 * Navigates the top window.
 *
 * Used for re-authorization: Shopify's consent screen sends
 * `frame-ancestors 'none'`, so loading it inside the app iframe renders an
 * empty panel with no error in the console. Escaping to the top frame first is
 * the only thing that works.
 */
export function openTop(url: string): void {
  // A relative URL would resolve against the *top* frame's origin — which is
  // admin.shopify.com, not this app — and 404 there. Absolutising against the
  // iframe's own origin first is what makes app-relative paths work.
  const absolute = new URL(url, window.location.origin).toString();

  const bridge = window.shopify;

  if (bridge?.open) {
    bridge.open(absolute, '_top');
    return;
  }

  // Outside the admin there is no top frame to escape to, and inside it this is
  // what App Bridge's own `open` does.
  window.top?.location.assign(absolute);
}

/**
 * Opens a URL in a new tab.
 *
 * Distinct from `openTop`, and the distinction matters: `openTop` navigates the
 * *whole Shopify admin* away from itself, which is right for an OAuth consent
 * screen the merchant must complete and wrong for anything they will come back
 * from. A support link that closed the admin behind them would be hostile.
 *
 * Routed through App Bridge where it exists because an embedded iframe is
 * sandboxed — a bare `window.open` is blocked in the admin, silently, with the
 * click appearing to do nothing at all.
 */
export function openExternal(url: string): void {
  const bridge = window.shopify;

  if (bridge?.open) {
    bridge.open(url, '_blank');
    return;
  }

  // `noopener` severs `window.opener`, so the opened page cannot navigate the
  // admin it came from.
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * The admin's save bar controller, or null when it is unavailable.
 *
 * Null in two situations that matter: outside the Shopify admin, and on an
 * App Bridge build predating `saveBar`. Callers must handle it — a save control
 * that silently fails to appear leaves a merchant unable to save at all.
 */
export function saveBarApi(): NonNullable<ShopifyGlobal['saveBar']> | null {
  return window.shopify?.saveBar ?? null;
}

/**
 * Opens Shopify's resource picker, or null when it is unavailable.
 *
 * Null outside the admin, and on an App Bridge without the picker. Callers must
 * handle it — a selector that silently does nothing leaves a merchant unable to
 * choose the products the whole screen is about.
 */
export async function pickResources(options: {
  type: 'product' | 'collection';
  selected: readonly string[];
}): Promise<string[] | null> {
  const picker = window.shopify?.resourcePicker;
  if (!picker) return null;

  const chosen = await picker({
    type: options.type,
    multiple: true,
    selectionIds: options.selected.map((id) => ({ id })),
  });

  // Cancelled. Distinct from an empty selection, which clears the list.
  if (!chosen) return null;

  return chosen.map((entry) => entry.id);
}

/** Shopify's native toast. Falls back to a no-op outside the admin. */
export function showToast(message: string, isError = false): void {
  window.shopify?.toast?.show(message, { isError });
}

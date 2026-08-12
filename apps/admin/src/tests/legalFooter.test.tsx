import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HELP_PAGES, LEGAL_PAGES } from '@codflow/shared';
import { renderWithPolaris } from './render';

/**
 * The footer.
 *
 * These are the links a Shopify reviewer clicks and a stuck merchant reaches
 * for, so the failures worth guarding are the silent ones: a link that opens
 * nothing because the admin iframe dropped the popup, a link that replaces the
 * whole Shopify admin with a privacy policy, and a Telegram button pointing at
 * an empty URL on a deployment that configured no support channel.
 */

const openExternal = vi.hoisted(() => vi.fn());
const navigateTop = vi.hoisted(() => vi.fn());
const openTop = vi.hoisted(() => vi.fn());

vi.mock('../lib/appBridge', async () => {
  const actual = await vi.importActual<typeof import('../lib/appBridge')>('../lib/appBridge');
  return { ...actual, openExternal, navigateTop, openTop };
});

const TELEGRAM = 'https://t.me/codkarsupport';

/**
 * The build-time global is read at module load, so the stub has to be in place
 * before the import — hence `resetModules` and a dynamic import per test rather
 * than a top-level one.
 */
async function renderFooter(telegramUrl: string | undefined = TELEGRAM) {
  vi.resetModules();
  vi.stubGlobal('__SUPPORT_TELEGRAM_URL__', telegramUrl);

  const { LegalFooter } = await import('../components/LegalFooter');

  return renderWithPolaris(<LegalFooter />);
}

/**
 * Queries by exact accessible name.
 *
 * A loose /Support/i matches both the Support policy and the Telegram button's
 * "Chat with support on Telegram" label, which is ambiguous rather than wrong —
 * so every lookup here is anchored.
 */
function link(name: string) {
  return screen.getByRole('button', { name: `${name} — opens in a new tab` });
}

function queryLink(name: string) {
  return screen.queryByRole('button', { name: `${name} — opens in a new tab` });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what it renders', () => {
  it('links every help page and every legal page', async () => {
    await renderFooter();

    for (const page of [...HELP_PAGES, ...LEGAL_PAGES]) {
      expect(link(page.title)).toBeTruthy();
    }
  });

  it('shows the FAQ, which is a help page rather than a policy', async () => {
    await renderFooter();

    expect(HELP_PAGES.map((page) => page.title)).toContain('FAQ');
    expect(LEGAL_PAGES.map((page) => page.title)).not.toContain('FAQ');
    expect(link('FAQ')).toBeTruthy();
  });

  it('covers the documents an App Store review expects', async () => {
    await renderFooter();

    const titles = LEGAL_PAGES.map((page) => page.title);

    expect(titles).toContain('Privacy Policy');
    expect(titles).toContain('Terms of Service');
  });

  it('says a link leaves the app, which a button cannot convey on its own', async () => {
    await renderFooter();

    expect(screen.getByLabelText(/Privacy Policy — opens in a new tab/i)).toBeTruthy();
  });
});

describe('the Telegram link', () => {
  it('opens the configured support channel', async () => {
    await renderFooter();

    await userEvent.click(link('Chat with support on Telegram'));

    expect(openExternal).toHaveBeenCalledWith(TELEGRAM);
  });

  it('is absent when the deployment configured no channel', async () => {
    // A support link opening a blank Telegram page is worse than no link —
    // the same rule SupportWidget follows.
    await renderFooter('');

    expect(queryLink('Chat with support on Telegram')).toBeNull();
  });

  /*
   * There is deliberately no test for "the global was never injected". Vite
   * replaces `__SUPPORT_TELEGRAM_URL__` textually via `define`, so it is not a
   * global lookup a test can remove — stubbing it produces results that depend
   * on module-cache timing rather than on the component. The `typeof` guard in
   * the source exists to avoid a ReferenceError in that case; the behaviour it
   * produces is identical to the empty string covered above.
   */
});

describe('how the links open', () => {
  it('sends the FAQ to /help, not /legal', async () => {
    await renderFooter();

    await userEvent.click(link('FAQ'));

    const url = new URL(openExternal.mock.calls[0]?.[0] as string);

    expect(url.pathname).toBe('/help/faq');
  });

  it('opens in a new tab through App Bridge', async () => {
    await renderFooter();

    await userEvent.click(link('Privacy Policy'));

    // A bare window.open is dropped silently inside the admin's sandboxed
    // iframe, so the click would appear to do nothing at all.
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0]?.[0]).toMatch(/\/legal\/privacy$/);
  });

  it('never navigates the top frame', async () => {
    await renderFooter();

    await userEvent.click(link('Terms of Service'));

    // Doing so would replace the entire Shopify admin with a policy page.
    expect(navigateTop).not.toHaveBeenCalled();
    expect(openTop).not.toHaveBeenCalled();
  });

  it('sends an absolute URL on this app’s origin', async () => {
    await renderFooter();

    await userEvent.click(link('Support'));

    // A relative path would resolve against admin.shopify.com and 404 there.
    const url = new URL(openExternal.mock.calls[0]?.[0] as string);

    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe('/legal/support');
  });
});

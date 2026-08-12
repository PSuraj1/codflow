import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LEGAL_PAGES } from '@codflow/shared';
import { renderWithPolaris } from './render';

/**
 * The policy footer.
 *
 * These are the links a Shopify reviewer clicks, so the failures worth guarding
 * are the silent ones: a link that opens nothing because the admin iframe
 * dropped the popup, and a link that replaces the whole Shopify admin with a
 * privacy policy the merchant then cannot navigate back from.
 */

const openExternal = vi.hoisted(() => vi.fn());
const navigateTop = vi.hoisted(() => vi.fn());
const openTop = vi.hoisted(() => vi.fn());

vi.mock('../lib/appBridge', async () => {
  const actual = await vi.importActual<typeof import('../lib/appBridge')>('../lib/appBridge');
  return { ...actual, openExternal, navigateTop, openTop };
});

const { LegalFooter } = await import('../components/LegalFooter');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('what it renders', () => {
  it('links every page the app serves', () => {
    renderWithPolaris(<LegalFooter />);

    // Driven by the shared list rather than a hardcoded four, so adding a page
    // to LEGAL_PAGES without rendering it fails here.
    for (const page of LEGAL_PAGES) {
      expect(screen.getByRole('button', { name: new RegExp(page.title, 'i') })).toBeTruthy();
    }
  });

  it('covers the documents an App Store review expects', () => {
    const titles = LEGAL_PAGES.map((page) => page.title);

    expect(titles).toContain('Privacy Policy');
    expect(titles).toContain('Terms of Service');
  });

  it('says the link leaves the app, which a button cannot convey on its own', () => {
    renderWithPolaris(<LegalFooter />);

    expect(screen.getByLabelText(/Privacy Policy — opens in a new tab/i)).toBeTruthy();
  });
});

describe('how the links open', () => {
  it('opens in a new tab through App Bridge', async () => {
    renderWithPolaris(<LegalFooter />);

    await userEvent.click(screen.getByRole('button', { name: /Privacy Policy/i }));

    // A bare window.open is dropped silently inside the admin's sandboxed
    // iframe, so the click would appear to do nothing at all.
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal.mock.calls[0]?.[0]).toMatch(/\/legal\/privacy$/);
  });

  it('never navigates the top frame', async () => {
    renderWithPolaris(<LegalFooter />);

    await userEvent.click(screen.getByRole('button', { name: /Terms of Service/i }));

    // Doing so would replace the entire Shopify admin with a policy page.
    expect(navigateTop).not.toHaveBeenCalled();
    expect(openTop).not.toHaveBeenCalled();
  });

  it('sends an absolute URL on this app’s origin', async () => {
    renderWithPolaris(<LegalFooter />);

    await userEvent.click(screen.getByRole('button', { name: /Support/i }));

    // A relative path would resolve against admin.shopify.com and 404 there.
    const url = new URL(openExternal.mock.calls[0]?.[0] as string);

    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe('/legal/support');
  });
});

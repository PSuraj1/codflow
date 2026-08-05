import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ShopVisibilitySummary } from '@codflow/shared';
import { VisibilityPage } from '../routes/VisibilityPage';
import { SETTINGS_TABS, tabIndexFor } from '../components/SectionTabs';

/**
 * Where COD is offered.
 *
 * Every setting here can stop orders arriving, and two of them can do it
 * without looking like they have: an allow list with nothing in it refuses
 * everything, and a country code with a typo refuses a whole market. Both are
 * reported rather than left to be discovered from an empty dashboard.
 */

const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock('../lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiClient')>('../lib/apiClient');
  return { ...actual, api: { get, patch, post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

function visibility(overrides: Partial<ShopVisibilitySummary> = {}): ShopVisibilitySummary {
  return {
    codEnabled: true,
    replaceAddToCart: false,
    replaceBuyNow: true,
    enabledOnAllProducts: true,
    includedProductGids: [],
    excludedProductGids: [],
    includedCollectionGids: [],
    allowedCountryCodes: [],
    blockedCountryCodes: [],
    allowedPostalPatterns: [],
    blockedPostalPatterns: [],
    minOrderValue: null,
    maxOrderValue: null,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <AppProvider i18n={enTranslations}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/settings/visibility']}>
          <VisibilityPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AppProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(visibility());
});

describe('the master switch', () => {
  it('reports when COD is switched off', async () => {
    get.mockResolvedValue(visibility({ codEnabled: false }));

    renderPage();

    expect(await screen.findByText(/shoppers see your normal checkout/i)).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('shows it live when COD is on', async () => {
    renderPage();
    expect(await screen.findByText('Live')).toBeTruthy();
  });
});

describe('product restriction', () => {
  it('hides the selectors while COD is offered on everything', async () => {
    renderPage();

    await screen.findByText('Which products');
    expect(screen.queryByText('Only these products')).toBeNull();
  });

  /**
   * The quiet failure: turning off "every product" and choosing nothing refuses
   * COD on the entire catalogue, and the storefront gives no hint why.
   */
  it('warns when nothing at all is included', async () => {
    get.mockResolvedValue(
      visibility({
        enabledOnAllProducts: false,
        includedProductGids: [],
        includedCollectionGids: [],
      }),
    );

    renderPage();

    expect(await screen.findByText(/COD is offered on no product at all/i)).toBeTruthy();
  });

  it('stays quiet once something is included', async () => {
    get.mockResolvedValue(
      visibility({
        enabledOnAllProducts: false,
        includedProductGids: ['gid://shopify/Product/1'],
      }),
    );

    renderPage();

    await screen.findByText('Only these products');
    expect(screen.queryByText(/no product at all/i)).toBeNull();
  });
});

describe('country codes', () => {
  /** A typo in an allow list refuses a whole market, silently. */
  it('reports a code that is not a country', async () => {
    get.mockResolvedValue(visibility({ allowedCountryCodes: ['IN', 'XX'] }));

    renderPage();

    expect(await screen.findByText(/Not a country code: XX/)).toBeTruthy();
  });

  it('names the countries back so a valid list is readable', async () => {
    get.mockResolvedValue(visibility({ allowedCountryCodes: ['IN'] }));

    renderPage();

    expect(await screen.findByText(/India/)).toBeTruthy();
  });
});

describe('saving', () => {
  it('sends the edited settings', async () => {
    patch.mockResolvedValue(visibility({ replaceAddToCart: true }));

    renderPage();

    await userEvent.click(await screen.findByRole('checkbox', { name: /hide add to cart/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());

    const body = patch.mock.calls[0]?.[1] as ShopVisibilitySummary;
    expect(body.replaceAddToCart).toBe(true);
  });

  it('offers nothing to save until something changes', async () => {
    renderPage();

    await screen.findByText('Which products');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('postal codes', () => {
  /**
   * Moved to the fraud screen so anything list-shaped lives in one place. The
   * fields are still served by this endpoint — the move was navigation only —
   * so the guard is that this page no longer offers a second way to edit them.
   */
  it('are not editable from this screen', async () => {
    get.mockResolvedValue(visibility({ allowedPostalPatterns: ['560'] }));

    renderPage();

    await screen.findByText('Which products');
    expect(screen.queryByLabelText(/postal codes/i)).toBeNull();
  });

  it('says where they went', async () => {
    renderPage();
    expect(await screen.findByText(/postal-code coverage lives under fraud protection/i)).toBeTruthy();
  });
});

describe('the Settings section', () => {
  it('opens on Visibility', () => {
    expect(SETTINGS_TABS[0]?.path).toBe('/settings/visibility');
    expect(tabIndexFor('/settings/visibility', SETTINGS_TABS)).toBe(0);
  });
});

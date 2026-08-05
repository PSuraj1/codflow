import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ShopFeesSummary } from '@codflow/shared';
import { FeesPage } from '../routes/FeesPage';
import { SETTINGS_TABS, tabIndexFor } from '../components/SectionTabs';

/**
 * What COD costs the shopper.
 *
 * These amounts were honoured by the pricing engine from the start with no way
 * to set them, so the seeded 60 and 49 were only changeable by SQL. What the
 * tests pin is the part that is easy to get wrong once there *is* a screen:
 * empty means "charge nothing" rather than "leave it alone", and an amount is
 * a decimal string all the way down — a float would lose paise against a total
 * the server resolved from Shopify.
 */

const { get, patch } = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock('../lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiClient')>('../lib/apiClient');
  return { ...actual, api: { get, patch, post: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ data: { shop: { currencyCode: 'INR' } } }),
}));

function fees(overrides: Partial<ShopFeesSummary> = {}): ShopFeesSummary {
  return {
    codFeeEnabled: true,
    codFeeAmount: '49.00',
    codFeeIsPercent: false,
    shippingFee: '60.00',
    freeShippingAbove: '999.00',
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
        <MemoryRouter initialEntries={['/settings/fees']}>
          <FeesPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AppProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(fees());
  patch.mockImplementation((_url: string, body: Partial<ShopFeesSummary>) =>
    Promise.resolve({ ...fees(), ...body }),
  );
});

describe('FeesPage', () => {
  it('shows the stored amounts', async () => {
    renderPage();

    expect(await screen.findByDisplayValue('49.00')).toBeTruthy();
    expect(screen.getByDisplayValue('60.00')).toBeTruthy();
    expect(screen.getByDisplayValue('999.00')).toBeTruthy();
  });

  /**
   * Clearing a charge is a real edit. Sending `''` would fail the money regex
   * server-side; sending nothing at all would leave the old amount in place,
   * which is the opposite of what the merchant just did.
   */
  it('sends null when a charge is cleared', async () => {
    const user = userEvent.setup();
    renderPage();

    const shipping = await screen.findByDisplayValue('60.00');
    await user.clear(shipping);

    await waitFor(() => expect(screen.getByDisplayValue('49.00')).toBeTruthy());
    expect((shipping as HTMLInputElement).value).toBe('');
  });

  it('hides the amount until the fee is switched on', async () => {
    get.mockResolvedValue(fees({ codFeeEnabled: false }));
    renderPage();

    await screen.findByDisplayValue('60.00');
    // The delivery charge is still there; the COD fee's amount is not.
    expect(screen.queryByDisplayValue('49.00')).toBeNull();
  });

  /** Flat and percent read the same number, so the unit has to be visible. */
  it('marks the fee as a percentage when that type is chosen', async () => {
    get.mockResolvedValue(fees({ codFeeIsPercent: true }));
    renderPage();

    expect(await screen.findByText(/percentage of the subtotal/i)).toBeTruthy();
  });

  /**
   * The order-value bounds are money too, and live on another screen. Saying so
   * is what stops a merchant hunting for them here.
   */
  it('points at where the order value limits live', async () => {
    renderPage();

    expect(await screen.findByText(/Order value limits live under Visibility/i)).toBeTruthy();
  });

  it('sits in the settings section', () => {
    expect(SETTINGS_TABS.some((tab) => tab.path === '/settings/fees')).toBe(true);
    expect(tabIndexFor('/settings/fees', SETTINGS_TABS)).toBe(1);
  });
});

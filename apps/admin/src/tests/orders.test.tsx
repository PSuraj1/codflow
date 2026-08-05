import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { StuckOrderSummary } from '@codflow/shared';
import { OrdersPage } from '../routes/OrdersPage';
import { StuckOrderRow } from '../components/orders/StuckOrderRow';

/**
 * Order recovery.
 *
 * The dashboard's "Waiting for Shopify → Review" link pointed at `/orders`,
 * which never existed, so the one screen a merchant reaches for when orders are
 * not arriving was a 404.
 *
 * What is worth testing is the triage. The three groups are three different
 * problems — a failed push, a fraud hold, and a queue nothing is draining — and
 * showing them as one list would send a merchant retrying orders that a gate
 * will refuse, or waiting on a worker that is not running.
 */

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiClient')>('../lib/apiClient');
  return { ...actual, api: { get, post, patch: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

function order(overrides: Partial<StuckOrderSummary> = {}): StuckOrderSummary {
  return {
    reference: 'CF-AAAA1111',
    status: 'CONFIRMED',
    total: '1209.00',
    currency: 'INR',
    createdAt: new Date().toISOString(),
    pushAttempts: 0,
    pushError: null,
    riskAction: 'ALLOW',
    otpRequired: false,
    otpVerified: false,
    ...overrides,
  };
}

/**
 * One page of one group, as the server now returns it.
 *
 * The grouping moved server-side, so a test asks for a group and gets that
 * group — the page no longer partitions anything itself.
 */
function page(
  items: StuckOrderSummary[],
  overrides: Partial<{
    group: string;
    counts: { failing: number; held: number; waiting: number; capped: boolean };
    unattended: boolean;
    hasMore: boolean;
    nextCursor: string | null;
  }> = {},
) {
  return {
    group: 'failing',
    items,
    nextCursor: null,
    hasMore: false,
    counts: { failing: items.length, held: 0, waiting: 0, capped: false },
    unattended: false,
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
        <MemoryRouter>
          <OrdersPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AppProvider>,
  );
}

function renderRow(subject: StuckOrderSummary) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <AppProvider i18n={enTranslations}>
      <QueryClientProvider client={client}>
        <StuckOrderRow order={subject} />
      </QueryClientProvider>
    </AppProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('the recovery list', () => {
  it('shows an empty list as the healthy state, not as a problem', async () => {
    get.mockResolvedValue(page([], { counts: { failing: 0, held: 0, waiting: 0, capped: false } }));

    renderPage();

    expect(await screen.findByText(/every order has reached shopify/i)).toBeTruthy();
    expect(screen.getByText('All clear')).toBeTruthy();
  });

  /** The tab labels are the only place counts for the *other* groups appear. */
  it('shows how many are in each group, including the ones not on screen', async () => {
    get.mockResolvedValue(
      page([order()], { counts: { failing: 1, held: 7, waiting: 3, capped: false } }),
    );

    renderPage();

    // Polaris renders each tab twice — visibly and in its overflow menu — so
    // these are `getAllBy`, not `getBy`.
    expect(await screen.findAllByText(/Not getting through \(1\)/)).not.toHaveLength(0);
    expect(screen.getAllByText(/Held \(7\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Queued \(3\)/).length).toBeGreaterThan(0);
  });

  it('asks the server for one group rather than filtering here', async () => {
    get.mockResolvedValue(page([order()]));

    renderPage();

    await screen.findByText('CF-AAAA1111');

    expect(get).toHaveBeenCalledWith(
      '/admin/orders/stuck',
      expect.objectContaining({ query: expect.objectContaining({ group: 'failing', limit: 50 }) }),
    );
  });

  /**
   * A count that stopped at its ceiling is a floor, and saying "1,000" flat
   * would be a smaller number than the truth.
   */
  it('reports a capped count as a floor', async () => {
    get.mockResolvedValue(
      page([order()], { counts: { failing: 1000, held: 0, waiting: 0, capped: true } }),
    );

    renderPage();

    expect(await screen.findAllByText(/Not getting through \(1,000\+\)/)).not.toHaveLength(0);
    expect(screen.getByText(/more than a thousand orders are stuck/i)).toBeTruthy();
  });

  it('offers more only when there is another page', async () => {
    get.mockResolvedValue(page([order()], { hasMore: false }));

    renderPage();

    await screen.findByText('CF-AAAA1111');
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('offers to load the next page when there is one', async () => {
    get.mockResolvedValue(page([order()], { hasMore: true, nextCursor: 'abc' }));

    renderPage();

    expect(await screen.findByRole('button', { name: /load more/i })).toBeTruthy();
  });
});

describe('the unattended queue warning', () => {
  /**
   * Computed by the server across every group. Deriving it from the rows on
   * screen would make it vanish whenever the merchant opened another tab.
   */
  it('shows what the server reports, whichever group is open', async () => {
    get.mockResolvedValue(page([order()], { unattended: true }));

    renderPage();

    expect(await screen.findByText(/orders are not being picked up/i)).toBeTruthy();
    expect(screen.getByText(/dev:worker/)).toBeTruthy();
  });

  it('stays quiet when the server does not report it', async () => {
    get.mockResolvedValue(page([order()], { unattended: false }));

    renderPage();

    await screen.findByText('CF-AAAA1111');
    expect(screen.queryByText(/orders are not being picked up/i)).toBeNull();
  });
});

describe('manual verification', () => {
  /**
   * Nothing sends an OTP yet, so without this an order requiring one waits
   * forever with no action able to release it.
   */
  it('is offered on an order waiting for a code', () => {
    renderRow(order({ otpRequired: true, otpVerified: false }));

    expect(screen.getByRole('button', { name: /mark CF-AAAA1111 as verified/i })).toBeTruthy();
  });

  it('is not offered where nothing is waiting on it', () => {
    renderRow(order({ otpRequired: false }));

    expect(screen.queryByRole('button', { name: /as verified/i })).toBeNull();
  });

  it('is not offered once the code is already verified', () => {
    renderRow(order({ otpRequired: true, otpVerified: true }));

    expect(screen.queryByRole('button', { name: /as verified/i })).toBeNull();
  });

  it('asks the server to verify', async () => {
    post.mockResolvedValue({
      reference: 'CF-AAAA1111',
      otpVerified: true,
      queued: true,
      heldReason: null,
    });

    renderRow(order({ otpRequired: true, otpVerified: false }));

    await userEvent.click(screen.getByRole('button', { name: /mark CF-AAAA1111 as verified/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/orders/CF-AAAA1111/verify'),
    );
  });
});

describe('money', () => {
  /** The rest of the app renders through `formatMoney`; this used to print raw. */
  it('is formatted rather than printed raw', () => {
    renderRow(order({ total: '1209.00', currency: 'INR' }));

    expect(screen.queryByText(/1209\.00 INR/)).toBeNull();
    expect(screen.getByText(/1,209/)).toBeTruthy();
  });
});

describe('StuckOrderRow', () => {
  it('shows the push failure verbatim', () => {
    renderRow(order({ status: 'FAILED', pushError: 'Variant 42 is out of stock' }));

    expect(screen.getByText('Variant 42 is out of stock')).toBeTruthy();
  });

  it('says when an order has never been attempted', () => {
    renderRow(order({ pushAttempts: 0 }));

    expect(screen.getByText(/never attempted/i)).toBeTruthy();
  });

  it('asks the server to retry', async () => {
    post.mockResolvedValue({ reference: 'CF-AAAA1111', queued: true, jobId: 'job-1' });

    renderRow(order());

    await userEvent.click(screen.getByRole('button', { name: /send CF-AAAA1111 to shopify again/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/orders/CF-AAAA1111/retry-push'),
    );
  });

  /**
   * Whether a retry is permitted is a gate decision, and the gates are on the
   * server. The row offers the retry and lets the server refuse with a reason,
   * rather than keeping a second copy of the rules that can drift.
   */
  it('offers the retry even on a held order', () => {
    renderRow(order({ riskAction: 'REVIEW' }));

    expect(screen.getByRole('button', { name: /to shopify again/i })).toBeTruthy();
    expect(screen.getByText('Held for review')).toBeTruthy();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PixelSummary } from '@codflow/shared';
import { PixelForm } from '../components/pixels/PixelForm';
import { PixelCard } from '../components/pixels/PixelCard';
import { eventsFor } from '../components/pixels/providerCatalogue';

/**
 * The pixel screen.
 *
 * Everything worth testing here is a way for the UI to quietly corrupt a
 * merchant's ad reporting rather than to look wrong:
 *
 *  - Clearing a stored Conversions API token by accident stops every
 *    server-side event, and nothing on the storefront changes to show it.
 *  - Offering an event a provider has no name for enables something that is
 *    silently dropped.
 *  - A pixel with a test event code set reaches the platform's test view only,
 *    so the merchant sees events arriving and no conversions recorded.
 */

const { post, patch } = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn() }));

vi.mock('../lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiClient')>('../lib/apiClient');
  return { ...actual, api: { post, patch, get: vi.fn(), put: vi.fn(), delete: vi.fn() } };
});

function pixel(overrides: Partial<PixelSummary> = {}): PixelSummary {
  return {
    id: 'pix_1',
    provider: 'META',
    label: 'Main Meta pixel',
    pixelId: '123456789012345',
    isEnabled: true,
    clientSideEnabled: true,
    serverSideEnabled: true,
    hasAccessToken: true,
    testEventCode: null,
    conversionLabel: null,
    conversionId: null,
    gtmContainerId: null,
    advancedMatching: true,
    deduplication: true,
    requireConsent: true,
    enabledEvents: [],
    lastEventAt: null,
    totalSent: 0,
    totalFailed: 0,
    lastError: null,
    ...overrides,
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <AppProvider i18n={enTranslations}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </AppProvider>,
  );
}

// Without this, `mock.calls[0]` in one test is the previous test's request.
beforeEach(() => vi.clearAllMocks());

describe('the access token', () => {
  /**
   * The important one. The token is write-only, so a blank field on an edit
   * means "unchanged" — sending `''` would store an empty credential and every
   * server-side event would fail authentication from then on.
   */
  it('is left untouched when the field is not filled in', async () => {
    patch.mockResolvedValue(pixel());

    renderWithQuery(<PixelForm pixel={pixel()} open onClose={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());

    const body = patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('accessToken' in body).toBe(false);
  });

  it('is cleared only when the merchant explicitly asks', async () => {
    patch.mockResolvedValue(pixel({ hasAccessToken: false }));

    renderWithQuery(<PixelForm pixel={pixel()} open onClose={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: /remove the stored token/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patch).toHaveBeenCalled());

    const body = patch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.accessToken).toBeNull();
  });

  /**
   * It used to appear only once server-side sending was ticked, which made it
   * undiscoverable: a merchant who came to paste a CAPI token found no field
   * for it and nothing saying one existed.
   */
  it('is offered before server-side sending is switched on', () => {
    renderWithQuery(
      <PixelForm
        pixel={pixel({ serverSideEnabled: false, hasAccessToken: false })}
        open
        onClose={() => undefined}
      />,
    );

    expect(screen.getByLabelText('Access token')).toBeTruthy();
    expect(screen.getByText(/tick that above to use it/i)).toBeTruthy();
  });

  it('warns before a save the server would refuse', async () => {
    renderWithQuery(
      <PixelForm pixel={pixel({ hasAccessToken: false })} open onClose={() => undefined} />,
    );

    expect(screen.getByText(/server-side tracking needs a token/i)).toBeTruthy();
  });

  it('is not asked for by a provider that authenticates another way', () => {
    // Google Ads carries its credential in the conversion fields.
    renderWithQuery(
      <PixelForm
        pixel={pixel({ provider: 'GOOGLE_ADS', pixelId: 'AW-123456789', hasAccessToken: false })}
        open
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByText(/conversions api token/i)).toBeNull();
    expect(screen.getByLabelText('Conversion label')).toBeTruthy();
  });
});

describe('the name placeholder', () => {
  /**
   * It was hardcoded to "Main Meta pixel", so choosing TikTok left a
   * suggestion for the wrong platform sitting in the field — which reads as the
   * form not having noticed the change.
   */
  it('follows the chosen platform', async () => {
    renderWithQuery(<PixelForm pixel={null} open onClose={() => undefined} />);

    expect(screen.getByLabelText('Name').getAttribute('placeholder')).toBe('Main Meta pixel');

    await userEvent.selectOptions(screen.getByLabelText('Ad platform'), 'TIKTOK');

    expect(screen.getByLabelText('Name').getAttribute('placeholder')).toBe('Main TikTok pixel');
  });
});

describe('the event list', () => {
  /** Sending an event a provider has no name for records nothing a campaign uses. */
  it('offers only events the provider can receive', () => {
    renderWithQuery(
      <PixelForm
        pixel={pixel({ provider: 'GOOGLE_ADS', pixelId: 'AW-1' })}
        open
        onClose={() => undefined}
      />,
    );

    // Google Ads has no vocabulary for browsing events.
    expect(screen.queryByRole('checkbox', { name: 'Product viewed' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Order placed' })).toBeTruthy();
  });

  it('derives the offer from the shared provider map', () => {
    expect(eventsFor('GOOGLE_ADS')).toEqual(['PURCHASE', 'LEAD']);
    expect(eventsFor('META')).toContain('VIEW_CONTENT');
  });
});

describe('a pixel that cannot send', () => {
  it('cannot be saved with both delivery methods off', async () => {
    renderWithQuery(<PixelForm pixel={pixel()} open onClose={() => undefined} />);

    await userEvent.click(screen.getByRole('checkbox', { name: /from the shopper's browser/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /from codkar's server/i }));

    expect(screen.getByText(/would never send anything/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('PixelCard', () => {
  /** Events reach the test view only — visible in the platform, absent from reporting. */
  it('says when a test event code is diverting events', () => {
    renderWithQuery(<PixelCard pixel={pixel({ testEventCode: 'TEST123' })} onEdit={() => undefined} />);

    expect(screen.getByText(/not live reporting/i)).toBeTruthy();
  });

  it('surfaces the provider’s last rejection', () => {
    renderWithQuery(
      <PixelCard pixel={pixel({ lastError: 'Invalid access token' })} onEdit={() => undefined} />,
    );

    expect(screen.getByText('Invalid access token')).toBeTruthy();
  });

  it('flags server-side tracking that has no token behind it', () => {
    renderWithQuery(
      <PixelCard pixel={pixel({ hasAccessToken: false })} onEdit={() => undefined} />,
    );

    expect(screen.getByText('No token')).toBeTruthy();
  });

  /** The tester sends a real server-to-server event; it proves nothing otherwise. */
  it('offers the tester only where server-side sending is on', () => {
    const { unmount } = renderWithQuery(
      <PixelCard pixel={pixel({ serverSideEnabled: false })} onEdit={() => undefined} />,
    );

    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
    unmount();

    renderWithQuery(<PixelCard pixel={pixel()} onEdit={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Send test' })).toBeTruthy();
  });

  it('asks before removing a pixel', async () => {
    renderWithQuery(<PixelCard pixel={pixel()} onEdit={() => undefined} />);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText(/remove this pixel\?/i)).toBeTruthy();
  });
});

describe('provider lock', () => {
  /**
   * The identifier format is validated per provider on create only, so allowing
   * a switch here would leave a pixel whose id belongs to another platform —
   * saving cleanly and sending every conversion nowhere.
   */
  it('cannot be changed on an existing pixel', () => {
    renderWithQuery(<PixelForm pixel={pixel()} open onClose={() => undefined} />);

    expect(screen.getByLabelText('Ad platform').hasAttribute('disabled')).toBe(true);
  });

  it('can be chosen freely when adding', () => {
    renderWithQuery(<PixelForm pixel={null} open onClose={() => undefined} />);

    expect(screen.getByLabelText('Ad platform').hasAttribute('disabled')).toBe(false);
  });
});

describe('identifier guidance', () => {
  /** Shown before the paste, mirroring the server's own refusal message. */
  it('describes the shape the platform uses', () => {
    renderWithQuery(<PixelForm pixel={null} open onClose={() => undefined} />);

    expect(screen.getByText(/15–16 digit number/i)).toBeTruthy();
  });
});

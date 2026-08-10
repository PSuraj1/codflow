import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SetupStepKey, SetupStepState, type SetupGuide, type SetupStep } from '@codflow/shared';

/**
 * The setup checklist.
 *
 * The card's job is to be honest about state it does not fully control, so the
 * tests are mostly about what it must *not* do: claim a merchant skipped a step
 * when the check failed, keep nagging someone who dismissed it, or route the
 * theme editor through the client router — which would try to render Shopify's
 * admin inside this app and land on the 404 page.
 */

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const navigateTop = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock('../lib/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiClient')>('../lib/apiClient');
  return { ...actual, api: { get, put, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});

vi.mock('../lib/appBridge', async () => {
  const actual = await vi.importActual<typeof import('../lib/appBridge')>('../lib/appBridge');
  return { ...actual, navigateTop, showToast: vi.fn() };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const { SetupGuideCard } = await import('../components/SetupGuideCard');

function step(overrides: Partial<SetupStep> = {}): SetupStep {
  return {
    key: SetupStepKey.COD_LIVE,
    title: 'Turn cash on delivery on',
    state: SetupStepState.TODO,
    summary: 'COD is switched off.',
    optional: false,
    actionPath: '/settings/visibility',
    actionUrl: null,
    actionLabel: 'Turn it on',
    ...overrides,
  };
}

function guide(overrides: Partial<SetupGuide> = {}): SetupGuide {
  return {
    steps: [step()],
    requiredTotal: 4,
    requiredDone: 3,
    complete: false,
    dismissed: false,
    ...overrides,
  };
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppProvider i18n={enTranslations}>
          <SetupGuideCard />
        </AppProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('what the merchant sees', () => {
  it('shows progress against the required steps only', async () => {
    get.mockResolvedValue(guide());

    renderCard();

    expect(await screen.findByText('3 of 4')).toBeTruthy();
    expect(screen.getByText('Set up CODkar')).toBeTruthy();
  });

  it('changes its heading once everything required is done', async () => {
    get.mockResolvedValue(guide({ requiredDone: 4, complete: true }));

    renderCard();

    expect(await screen.findByText('You are ready to take COD orders')).toBeTruthy();
  });

  it('marks an optional step so it does not read as outstanding work', async () => {
    get.mockResolvedValue(
      guide({ steps: [step({ key: SetupStepKey.SHEETS, title: 'Google Sheets', optional: true })] }),
    );

    renderCard();

    expect(await screen.findByText('Optional')).toBeTruthy();
  });

  it('says a check failed rather than showing the step as incomplete', async () => {
    get.mockResolvedValue(
      guide({
        steps: [
          step({
            key: SetupStepKey.EMBED,
            state: SetupStepState.UNKNOWN,
            summary: 'Could not check your theme just now.',
          }),
        ],
      }),
    );

    renderCard();

    expect(await screen.findByText('Could not check')).toBeTruthy();
  });
});

describe('staying out of the way', () => {
  it('renders nothing once dismissed', async () => {
    get.mockResolvedValue(guide({ dismissed: true }));

    const { container } = renderCard();

    // Waits for the query to settle so this cannot pass merely by being early.
    await waitFor(() => expect(get).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing when the guide itself fails', async () => {
    // A merchant can do nothing about this, and a red box on the dashboard
    // would imply their store is broken when it is not.
    get.mockRejectedValue(new Error('offline'));

    const { container } = renderCard();

    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('dismisses through the existing onboarding endpoint', async () => {
    get.mockResolvedValue(guide());
    put.mockResolvedValue({ completed: true, step: 3 });

    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/admin/shop/onboarding', { step: 3, completed: true }),
    );
  });
});

describe('actions', () => {
  it('routes an in-app step through the client router', async () => {
    get.mockResolvedValue(guide());

    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Turn it on' }));

    expect(navigate).toHaveBeenCalledWith('/settings/visibility');
    expect(navigateTop).not.toHaveBeenCalled();
  });

  it('escapes the frame for the theme editor instead of routing to it', async () => {
    const editorUrl = 'https://admin.shopify.com/store/demo/themes/1/editor?context=apps';

    get.mockResolvedValue(
      guide({
        steps: [
          step({
            key: SetupStepKey.EMBED,
            title: 'Enable the app embed',
            actionPath: null,
            actionUrl: editorUrl,
            actionLabel: 'Open theme editor',
          }),
        ],
      }),
    );

    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Open theme editor' }));

    // Routing this internally would render Shopify's own admin URL as an app
    // route and land the merchant on the 404 page.
    expect(navigateTop).toHaveBeenCalledWith(editorUrl);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers no button for a finished step', async () => {
    get.mockResolvedValue(
      guide({ steps: [step({ state: SetupStepState.DONE, actionLabel: null })] }),
    );

    renderCard();

    await screen.findByText('Turn cash on delivery on');
    expect(screen.queryByRole('button', { name: 'Turn it on' })).toBeNull();
  });
});

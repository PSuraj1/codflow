import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { renderWithPolaris } from './render';
import { SaveBar } from '../components/SaveBar';
import { ErrorBoundary } from '../components/ErrorBoundary';

/**
 * The unsaved-changes bar, and the boundary behind it.
 *
 * These two are tested together because they were one bug. Every screen used
 * Polaris's `ContextualSaveBar`, which calls `useFrame()` and throws without a
 * `<Frame>` ancestor — this app has none, by design, because an embedded app
 * lets the admin render its own chrome. So the first keystroke on any form
 * threw. The error boundary then could not render its fallback either, because
 * the fallback uses Polaris and the boundary sat outside `AppProvider`, and the
 * merchant got a blank iframe with the real cause reported nowhere.
 *
 * Both halves are regression-tested: a save bar that does not throw, and a
 * fallback that renders where it is actually mounted.
 */

interface SaveBarStub {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
}

/** Installs a stand-in for the App Bridge global. */
function installAppBridge(): SaveBarStub {
  const stub: SaveBarStub = {
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
  };

  (window as unknown as { shopify?: unknown }).shopify = {
    idToken: vi.fn(),
    config: { apiKey: 'test' },
    saveBar: stub,
  };

  return stub;
}

afterEach(() => {
  delete (window as unknown as { shopify?: unknown }).shopify;
  vi.restoreAllMocks();
});

describe('SaveBar with App Bridge present', () => {
  it('does not throw when a form goes dirty', () => {
    installAppBridge();

    // The whole original defect in one assertion: this is the render that used
    // to throw "No Frame context was provided" and blank the app.
    expect(() =>
      renderWithPolaris(
        <SaveBar id="test-bar" dirty onSave={() => undefined} onDiscard={() => undefined} />,
      ),
    ).not.toThrow();
  });

  it('asks the admin to show the bar once the form is dirty', () => {
    const stub = installAppBridge();

    renderWithPolaris(
      <SaveBar id="test-bar" dirty onSave={() => undefined} onDiscard={() => undefined} />,
    );

    expect(stub.show).toHaveBeenCalledWith('test-bar');
  });

  it('keeps the bar hidden while the form is clean', () => {
    const stub = installAppBridge();

    renderWithPolaris(
      <SaveBar
        id="test-bar"
        dirty={false}
        onSave={() => undefined}
        onDiscard={() => undefined}
      />,
    );

    expect(stub.show).not.toHaveBeenCalled();
    expect(stub.hide).toHaveBeenCalledWith('test-bar');
  });

  /** Otherwise the admin keeps a bar wired to a screen that no longer exists. */
  it('hides the bar when the screen unmounts', () => {
    const stub = installAppBridge();

    const { unmount } = renderWithPolaris(
      <SaveBar id="test-bar" dirty onSave={() => undefined} onDiscard={() => undefined} />,
    );

    stub.hide.mockClear();
    unmount();

    expect(stub.hide).toHaveBeenCalledWith('test-bar');
  });

  it('declares the element the admin mirrors, with the confirming action marked', () => {
    installAppBridge();

    const { container } = renderWithPolaris(
      <SaveBar id="test-bar" dirty onSave={() => undefined} onDiscard={() => undefined} />,
    );

    const bar = container.querySelector('ui-save-bar');
    expect(bar?.getAttribute('id')).toBe('test-bar');
    expect(bar?.querySelector('button[variant="primary"]')).toBeTruthy();
  });
});

describe('SaveBar without App Bridge', () => {
  /**
   * A save control that silently fails to appear leaves the merchant unable to
   * save at all, which is worse than the crash it replaced.
   */
  it('falls back to in-page buttons', async () => {
    const onSave = vi.fn();

    renderWithPolaris(
      <SaveBar id="test-bar" dirty onSave={onSave} onDiscard={() => undefined} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalled();
  });

  it('shows nothing at all while the form is clean', () => {
    renderWithPolaris(
      <SaveBar
        id="test-bar"
        dirty={false}
        onSave={() => undefined}
        onDiscard={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('refuses to save a draft the screen has marked invalid', async () => {
    const onSave = vi.fn();

    renderWithPolaris(
      <SaveBar id="test-bar" dirty disabled onSave={onSave} onDiscard={() => undefined} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary', () => {
  function Boom(): never {
    throw new Error('the original failure');
  }

  it('renders its fallback, and the real error, inside AppProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppProvider i18n={enTranslations}>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </AppProvider>,
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    // The point of the fix: the cause is reported rather than swallowed by a
    // second failure inside the fallback.
    expect(screen.getByText('the original failure')).toBeTruthy();
  });
});

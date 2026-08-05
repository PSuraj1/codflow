import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The floating support button.
 *
 * The property worth protecting is the empty case. A deployment that sets no
 * channel must render *nothing* — a button opening `https://t.me/` looks like a
 * working support route right up until a merchant needs it, which is the worst
 * moment to discover it goes nowhere.
 */

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.mock('../lib/appBridge', () => ({ openExternal }));

/** Re-imports the component so the build-time constant is re-read. */
async function load(url: string) {
  vi.stubGlobal('__SUPPORT_TELEGRAM_URL__', url);
  vi.resetModules();
  return import('../components/SupportWidget');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('with no channel configured', () => {
  it('renders nothing at all', async () => {
    const { SupportWidget } = await load('');
    const { container } = render(<SupportWidget />);

    expect(container.firstChild).toBeNull();
  });

  it('treats whitespace as unconfigured', async () => {
    const { SupportWidget } = await load('   ');
    const { container } = render(<SupportWidget />);

    expect(container.firstChild).toBeNull();
  });
});

describe('with a channel configured', () => {
  const url = 'https://t.me/codflowsupport';

  it('renders a labelled button', async () => {
    const { SupportWidget } = await load(url);
    render(<SupportWidget />);

    // Named rather than found by icon: a screen reader user has no icon.
    expect(screen.getByRole('button', { name: /support on telegram/i })).toBeTruthy();
  });

  /**
   * Through App Bridge, not `window.open` — an embedded iframe is sandboxed and
   * a bare `window.open` is blocked silently, so the click appears to do
   * nothing.
   */
  it('opens the channel through App Bridge', async () => {
    const { SupportWidget } = await load(url);
    render(<SupportWidget />);

    await userEvent.click(screen.getByRole('button', { name: /support on telegram/i }));

    expect(openExternal).toHaveBeenCalledWith(url);
  });
});

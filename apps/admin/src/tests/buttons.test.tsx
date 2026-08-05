import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ButtonConfigSummary } from '@codflow/shared';
import { renderWithPolaris } from './render';
import { ButtonEditor } from '../components/buttons/ButtonEditor';
import { ButtonPreview } from '../components/buttons/ButtonPreview';
import { ColorField } from '../components/buttons/ColorField';

/**
 * The COD button customizer.
 *
 * The preview is the whole screen's claim: a merchant picks colours here and
 * never looks at their storefront again. So the tests are about it agreeing
 * with the theme extension — the same values, written the same way — and about
 * it saying so when it cannot show something.
 */

function button(overrides: Partial<ButtonConfigSummary> = {}): ButtonConfigSummary {
  return {
    placement: 'PRODUCT_PAGE',
    isEnabled: true,
    label: 'Order Now — Cash On Delivery',
    subLabel: null,
    bgColor: '#008060',
    textColor: '#FFFFFF',
    borderColor: '#008060',
    borderRadius: 8,
    fontSize: 16,
    fontWeight: '600',
    paddingY: 14,
    paddingX: 24,
    fullWidth: true,
    customCss: null,
    showOnMobile: true,
    showOnDesktop: true,
    showAfterScrollPx: 0,
    stickyOffsetBottom: 0,
    floatingPosition: 'bottom_right',
    animation: 'none',
    ...overrides,
  };
}

describe('ButtonPreview', () => {
  it('renders the label and the second line', () => {
    renderWithPolaris(
      <ButtonPreview button={button({ label: 'Pay at your door', subLabel: 'No card needed' })} />,
    );

    expect(screen.getByText('Pay at your door')).toBeTruthy();
    expect(screen.getByText('No card needed')).toBeTruthy();
  });

  it('leaves the second line out when there is none', () => {
    renderWithPolaris(<ButtonPreview button={button({ subLabel: null })} />);

    expect(screen.queryByText('No card needed')).toBeNull();
  });

  it('applies the merchant’s colours and spacing', () => {
    renderWithPolaris(
      renderPreview({ bgColor: '#112233', textColor: '#FFEECC', paddingY: 20, borderRadius: 30 }),
    );

    const preview = screen.getByTestId('cod-button-preview');

    expect(preview.style.background).toBe('rgb(17, 34, 51)');
    expect(preview.style.color).toBe('rgb(255, 238, 204)');
    expect(preview.style.borderRadius).toBe('30px');
    expect(preview.style.padding).toBe('20px 24px');
  });

  it('stretches only when the merchant asked it to', () => {
    renderWithPolaris(renderPreview({ fullWidth: false }));

    expect(screen.getByTestId('cod-button-preview').style.width).toBe('auto');
  });

  /**
   * Matches `codflow-button--anim-*` in the extension's stylesheet. A preview
   * that showed a still button while the storefront pulsed would be the one
   * part of this screen a merchant cannot check any other way.
   */
  it('plays the chosen animation', () => {
    renderWithPolaris(renderPreview({ animation: 'pulse' }));

    expect(screen.getByTestId('cod-button-preview').className).toContain('pulse');
  });

  it('adds no animation class when there is no animation', () => {
    renderWithPolaris(renderPreview({ animation: 'none' }));

    expect(screen.getByTestId('cod-button-preview').className).toBe('');
  });

  it('says so when the placement is switched off', () => {
    renderWithPolaris(<ButtonPreview button={button({ isEnabled: false })} />);

    expect(screen.getByText(/nothing renders on your storefront/i)).toBeTruthy();
  });

  /** The rules are written against the storefront's cascade, not this page. */
  it('explains that custom CSS is not previewed', () => {
    renderWithPolaris(<ButtonPreview button={button({ customCss: '.codflow-button {}' })} />);

    expect(screen.getByText(/not applied here/i)).toBeTruthy();
  });

  it('stays quiet about custom CSS the plan does not run anyway', () => {
    renderWithPolaris(
      <ButtonPreview button={button({ customCss: '.codflow-button {}' })} customCssActive={false} />,
    );

    expect(screen.queryByText(/not applied here/i)).toBeNull();
  });

  function renderPreview(overrides: Partial<ButtonConfigSummary>) {
    return <ButtonPreview button={button(overrides)} />;
  }
});

describe('ButtonEditor', () => {
  function renderEditor(overrides: Partial<ButtonConfigSummary> = {}) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    return render(
      <AppProvider i18n={enTranslations}>
        <QueryClientProvider client={client}>
          <ButtonEditor button={button(overrides)} customCssAllowed />
        </QueryClientProvider>
      </AppProvider>,
    );
  }

  /**
   * The regression that sent every screen blank: editing any field made the
   * panel dirty, the save bar mounted, and Polaris's `ContextualSaveBar` threw
   * for want of a `<Frame>`. The merchant could not change a single value.
   */
  it('survives a checkbox being clicked', async () => {
    renderEditor();

    await userEvent.click(screen.getByRole('checkbox', { name: /stretch to the full width/i }));

    expect(screen.getByText('Wording')).toBeTruthy();
  });

  it('survives typing in a text field', async () => {
    renderEditor();

    await userEvent.type(screen.getByLabelText('Label'), '!');

    expect(screen.getByText('Appearance')).toBeTruthy();
  });

  it('offers a way to save once something changes', async () => {
    renderEditor();

    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: /stretch to the full width/i }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('warns before saving a button that could never appear', async () => {
    renderEditor({ isEnabled: true, showOnMobile: true, showOnDesktop: false });

    await userEvent.click(screen.getByRole('checkbox', { name: 'On mobile' }));

    expect(screen.getByText(/would never appear/i)).toBeTruthy();
  });

  /** A floating-only control has no meaning on a button inside the product form. */
  it('hides the corner picker on a placement that has no corner', () => {
    renderEditor({ placement: 'PRODUCT_PAGE' });

    expect(screen.queryByLabelText('Corner')).toBeNull();
  });

  it('shows the corner picker and scroll controls on the floating button', () => {
    renderEditor({ placement: 'FLOATING' });

    expect(screen.getByLabelText('Corner')).toBeTruthy();
    expect(screen.getByLabelText(/appear after the shopper scrolls/i)).toBeTruthy();
  });
});

describe('ColorField', () => {
  it('reports a value the server would refuse', () => {
    renderWithPolaris(
      <ColorField label="Background" value="red;position:fixed" onChange={() => undefined} />,
    );

    expect(screen.getByText(/hex colour/i)).toBeTruthy();
  });

  it('accepts a well-formed hex without complaint', () => {
    renderWithPolaris(
      <ColorField label="Background" value="#008060" onChange={() => undefined} />,
    );

    expect(screen.queryByText(/hex colour/i)).toBeNull();
  });
});

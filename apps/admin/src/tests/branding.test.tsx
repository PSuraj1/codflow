import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { ShopBrandingSummary } from '@codflow/shared';
import { renderWithPolaris } from './render';
import { FormAppearancePreview } from '../components/branding/FormAppearancePreview';

/**
 * COD form appearance.
 *
 * Every one of these values has been honoured by the storefront since the form
 * was built, and no admin screen could set any of them — so every shop rendered
 * CodFlow's default green whatever their own brand was.
 *
 * The preview is what a merchant judges the change by, so what matters is that
 * it uses the values verbatim rather than approximating them.
 */

function branding(overrides: Partial<ShopBrandingSummary> = {}): ShopBrandingSummary {
  return {
    primaryColor: '#008060',
    secondaryColor: '#004C3F',
    textColor: '#202223',
    fontFamily: 'inherit',
    borderRadius: 8,
    logoUrl: null,
    logoHeight: 40,
    logoAlignment: 'left',
    customCss: null,
    themeMode: 'SYSTEM',
    ...overrides,
  };
}

describe('FormAppearancePreview', () => {
  it('applies the merchant’s colours and radius', () => {
    renderWithPolaris(
      <FormAppearancePreview
        branding={branding({ textColor: '#112233', borderRadius: 24 })}
      />,
    );

    const preview = screen.getByTestId('form-appearance-preview');

    expect(preview.style.color).toBe('rgb(17, 34, 51)');
    expect(preview.style.borderRadius).toBe('24px');
  });

  it('applies the chosen font stack', () => {
    renderWithPolaris(
      <FormAppearancePreview branding={branding({ fontFamily: 'Georgia, Cambria, serif' })} />,
    );

    expect(screen.getByTestId('form-appearance-preview').style.fontFamily).toContain('Georgia');
  });

  it('darkens the surface when the merchant forces dark mode', () => {
    const { container } = renderWithPolaris(
      <FormAppearancePreview branding={branding({ themeMode: 'DARK' })} />,
    );

    const preview = container.querySelector('[data-testid="form-appearance-preview"]');
    expect((preview as HTMLElement).style.background).toBe('rgb(26, 26, 26)');
  });

  it('shows the logo only when one is set', () => {
    const { rerender, container } = renderWithPolaris(
      <FormAppearancePreview branding={branding()} />,
    );
    expect(container.querySelector('img')).toBeNull();

    rerender(<FormAppearancePreview branding={branding({ logoUrl: 'https://cdn.example/l.png' })} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/l.png');
  });

  /**
   * The preview promising a size the storefront ignores is how the logo went
   * unrendered for so long — a merchant saw it here and trusted it.
   */
  it('previews the logo at the merchant’s height', () => {
    const { container } = renderWithPolaris(
      <FormAppearancePreview
        branding={branding({ logoUrl: 'https://cdn.example/l.png', logoHeight: 96 })}
      />,
    );

    expect((container.querySelector('img') as HTMLElement).style.height).toBe('96px');
  });

  it.each([
    ['left', 'flex-start'],
    ['center', 'center'],
    ['right', 'flex-end'],
  ] as const)('previews %s alignment', (logoAlignment, expected) => {
    const { container } = renderWithPolaris(
      <FormAppearancePreview
        branding={branding({ logoUrl: 'https://cdn.example/l.png', logoAlignment })}
      />,
    );

    expect((container.querySelector('img') as HTMLElement).style.alignSelf).toBe(expected);
  });

  /** Those rules target the storefront's cascade and would leak into Polaris. */
  it('says the custom CSS is not previewed', () => {
    renderWithPolaris(<FormAppearancePreview branding={branding()} />);

    expect(screen.getByText(/colours and shape only/i)).toBeTruthy();
  });
});

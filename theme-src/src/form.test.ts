// @vitest-environment jsdom
import type { FormFieldDefinition, StorefrontBranding } from '@codflow/shared';
import { describe, expect, it } from 'vitest';
import { buildField, formatMoney, syncDialogLogo, type PageContext } from './form';

/**
 * Storefront form renderer.
 *
 * The validation logic here is the shared engine, tested in that package. What
 * these cover is the part that only exists in the browser: the markup, and
 * specifically the accessibility wiring that no type checker can verify.
 *
 * Those assertions are not decoration. A COD form is the entire checkout for
 * these merchants — a shopper who cannot use it with a screen reader cannot buy
 * at all, and Shopify's app review checks for exactly this.
 */

function field(overrides: Partial<FormFieldDefinition> = {}): FormFieldDefinition {
  return {
    id: 'f1',
    key: 'phone',
    type: 'TEXT',
    label: 'Phone number',
    placeholder: null,
    helpText: null,
    position: 0,
    enabled: true,
    system: false,
    hidden: false,
    defaultValue: null,
    validation: { required: false },
    options: [],
    conditional: null,
    columnWidth: 12,
    cssClass: null,
    translations: {},
    ...overrides,
  };
}

function context(moneyFormat: string): PageContext {
  return {
    shop: { domain: 'demo.myshopify.com', currency: 'INR', moneyFormat, locale: 'en', rootUrl: '/' },
    page: { type: 'product', template: 'product', designMode: false },
    product: { id: 1, variantId: 2, available: true, handle: 'p', title: 'P', price: 100, featuredImage: '' },
    cart: { itemCount: 0, totalPrice: 0 },
    customer: { isLoggedIn: false, email: '', firstName: '', lastName: '', phone: '' },
    strings: {},
  };
}

/**
 * The dialog logo.
 *
 * `logoUrl` reached the storefront config for months with nothing rendering it,
 * so these exist mainly to keep that from being true again. The idempotency
 * cases are the load-bearing ones: `render()` runs more than once per dialog.
 */
describe('syncDialogLogo', () => {
  function dialog(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = '<h2 class="codflow-dialog__title"></h2>';
    return root;
  }

  const logo = (root: HTMLElement) => root.querySelectorAll('.codflow-dialog__logo');

  function branding(overrides: Partial<StorefrontBranding> = {}): StorefrontBranding {
    return {
      primaryColor: '#008060',
      secondaryColor: '#004C3F',
      textColor: '#202223',
      fontFamily: 'inherit',
      borderRadius: 8,
      logoUrl: 'https://cdn.example/logo.png',
      logoHeight: 40,
      logoAlignment: 'left',
      customCss: null,
      themeMode: 'SYSTEM',
      ...overrides,
    };
  }

  it('inserts the logo before the heading', () => {
    const root = dialog();
    syncDialogLogo(root.querySelector('h2')!, branding({ logoUrl: 'https://cdn.example/logo.png' }));

    const img = root.querySelector('img.codflow-dialog__logo');
    expect(img?.getAttribute('src')).toBe('https://cdn.example/logo.png');
    // Before the title, so it reads as a header rather than sitting mid-dialog.
    expect(root.firstElementChild).toBe(img);
  });

  it('renders nothing when the merchant has no logo', () => {
    const root = dialog();
    syncDialogLogo(root.querySelector('h2')!, branding({ logoUrl: null }));

    expect(logo(root)).toHaveLength(0);
  });

  /** `render()` runs again on a locale change and after a failed submit. */
  it('does not stack duplicates across repeated renders', () => {
    const root = dialog();
    const title = root.querySelector('h2')!;

    syncDialogLogo(title, branding({ logoUrl: 'https://cdn.example/logo.png' }));
    syncDialogLogo(title, branding({ logoUrl: 'https://cdn.example/logo.png' }));
    syncDialogLogo(title, branding({ logoUrl: 'https://cdn.example/logo.png' }));

    expect(logo(root)).toHaveLength(1);
  });

  it('updates the source in place when the logo changes', () => {
    const root = dialog();
    const title = root.querySelector('h2')!;

    syncDialogLogo(title, branding({ logoUrl: 'https://cdn.example/old.png' }));
    syncDialogLogo(title, branding({ logoUrl: 'https://cdn.example/new.png' }));

    expect(logo(root)).toHaveLength(1);
    expect(root.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/new.png');
  });

  it('removes the logo when the merchant clears it', () => {
    const root = dialog();
    const title = root.querySelector('h2')!;

    syncDialogLogo(title, branding({ logoUrl: 'https://cdn.example/logo.png' }));
    syncDialogLogo(title, branding({ logoUrl: null }));

    expect(logo(root)).toHaveLength(0);
  });

  /**
   * Decorative: the heading beside it already names the dialog, so alt text
   * would make a screen reader announce the same thing twice.
   */
  it('marks the image decorative', () => {
    const root = dialog();
    syncDialogLogo(root.querySelector('h2')!, branding({ logoUrl: 'https://cdn.example/logo.png' }));

    expect(root.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('applies the merchant’s height', () => {
    const root = dialog();
    syncDialogLogo(root.querySelector('h2')!, branding({ logoHeight: 88 }));

    expect(root.querySelector('img')?.style.getPropertyValue('--codflow-logo-height')).toBe('88px');
  });

  /**
   * `auto` margins are what centre and right-align a block image. Asserting the
   * pair rather than a class name, because that pair is the actual mechanism.
   */
  it.each([
    ['left', '0px', 'auto'],
    ['center', 'auto', 'auto'],
    ['right', 'auto', '0px'],
  ] as const)('aligns %s', (logoAlignment, start, end) => {
    const root = dialog();
    syncDialogLogo(root.querySelector('h2')!, branding({ logoAlignment }));

    const image = root.querySelector('img')!;
    expect(image.style.marginInlineStart).toBe(start);
    expect(image.style.marginInlineEnd).toBe(end);
  });

  it('re-applies height and position when they change', () => {
    const root = dialog();
    const title = root.querySelector('h2')!;

    syncDialogLogo(title, branding({ logoHeight: 40, logoAlignment: 'left' }));
    syncDialogLogo(title, branding({ logoHeight: 100, logoAlignment: 'right' }));

    const image = root.querySelector('img')!;
    expect(logo(root)).toHaveLength(1);
    expect(image.style.getPropertyValue('--codflow-logo-height')).toBe('100px');
    expect(image.style.marginInlineEnd).toBe('0px');
  });
});

describe('formatMoney', () => {
  /**
   * Uses the shop's own `money_format` rather than `Intl.NumberFormat`. The
   * merchant has already decided how prices look on their storefront, and a COD
   * form that disagrees looks like it belongs to a different shop.
   */
  it('substitutes the amount placeholder', () => {
    expect(formatMoney(1234.5, context('₹{{amount}}'))).toBe('₹1,234.50');
  });

  it('substitutes the no-decimals placeholder', () => {
    expect(formatMoney(1234.5, context('${{amount_no_decimals}}'))).toBe('$1,235');
  });

  it('groups thousands', () => {
    expect(formatMoney(1234567.89, context('{{amount}}'))).toBe('1,234,567.89');
  });

  it('handles a comma-separator format', () => {
    expect(formatMoney(1234.5, context('€{{amount_with_comma_separator}}'))).toBe('€1,234,50');
  });

  it('tolerates whitespace inside the placeholder', () => {
    expect(formatMoney(10, context('{{ amount }}'))).toBe('10.00');
  });

  it('falls back when the shop has no money format', () => {
    expect(formatMoney(10, context(''))).toBe('10.00');
  });

  it('formats zero', () => {
    expect(formatMoney(0, context('₹{{amount}}'))).toBe('₹0.00');
  });
});

describe('buildField accessibility', () => {
  it('associates the label with the control', () => {
    const wrapper = buildField(field(), null);
    const label = wrapper.querySelector('label');
    const input = wrapper.querySelector('input');

    // Without this pairing a screen reader announces an unlabelled text box.
    expect(label?.getAttribute('for')).toBe(input?.id);
    expect(input?.id).toBeTruthy();
  });

  it('points aria-describedby at an error element that already exists', () => {
    const wrapper = buildField(field(), null);
    const input = wrapper.querySelector('input');
    const describedBy = input?.getAttribute('aria-describedby');

    // The error node is rendered up front, empty and hidden. An element that
    // only appears on failure is one `aria-describedby` cannot reference ahead
    // of time, and screen readers announce nothing when it materialises.
    expect(describedBy).toBeTruthy();
    expect(wrapper.querySelector(`#${describedBy}`)).not.toBeNull();
  });

  it('marks the error region as a live alert', () => {
    const error = buildField(field(), null).querySelector('.codflow-error');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.hasAttribute('hidden')).toBe(true);
  });

  it('flags a required field to assistive technology', () => {
    const wrapper = buildField(field({ validation: { required: true } }), null);
    expect(wrapper.querySelector('input')?.getAttribute('aria-required')).toBe('true');
  });

  it('hides the decorative asterisk from screen readers', () => {
    // The requirement is already conveyed by aria-required; announcing "star"
    // as well is noise.
    const wrapper = buildField(field({ validation: { required: true } }), null);
    expect(wrapper.querySelector('.codflow-required')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('buildField control types', () => {
  it.each([
    ['EMAIL', 'email', 'email'],
    ['PHONE', 'tel', 'tel'],
    ['POSTAL_CODE', 'text', 'postal-code'],
  ] as const)('renders %s as input[type=%s] with autocomplete', (type, inputType, autocomplete) => {
    const wrapper = buildField(field({ type, key: type === 'EMAIL' ? 'email' : 'phone' }), null);
    const input = wrapper.querySelector('input');

    expect(input?.getAttribute('type')).toBe(inputType);
    expect(input?.getAttribute('autocomplete')).toBe(autocomplete);
  });

  it('renders a textarea for long text', () => {
    expect(buildField(field({ type: 'TEXTAREA' }), null).querySelector('textarea')).not.toBeNull();
  });

  it('renders a select with a placeholder option', () => {
    const wrapper = buildField(
      field({ type: 'SELECT', options: [{ label: 'A', value: 'a' }] }),
      null,
    );

    const options = wrapper.querySelectorAll('option');
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute('value')).toBe('');
  });

  it('marks the selected option', () => {
    const wrapper = buildField(
      field({
        type: 'SELECT',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      }),
      'b',
    );

    expect(wrapper.querySelector('option[value="b"]')?.hasAttribute('selected')).toBe(true);
  });

  it('gives each radio in a group a distinct id but a shared name', () => {
    const wrapper = buildField(
      field({
        type: 'RADIO',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      }),
      null,
    );

    const radios = [...wrapper.querySelectorAll('input[type="radio"]')];
    const ids = radios.map((radio) => radio.id);

    expect(new Set(ids).size).toBe(2);
    expect(new Set(radios.map((radio) => radio.getAttribute('name'))).size).toBe(1);
    expect(wrapper.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('applies numeric bounds to a number input', () => {
    const wrapper = buildField(
      field({ type: 'NUMBER', validation: { required: false, minValue: 1, maxValue: 10 } }),
      null,
    );
    const input = wrapper.querySelector('input');

    expect(input?.getAttribute('min')).toBe('1');
    expect(input?.getAttribute('max')).toBe('10');
    expect(input?.getAttribute('inputmode')).toBe('numeric');
  });

  it('checks a consent box that starts true', () => {
    const wrapper = buildField(field({ type: 'CONSENT' }), true);
    expect(wrapper.querySelector('input[type="checkbox"]')?.hasAttribute('checked')).toBe(true);
  });
});

describe('buildField presentational types', () => {
  it.each([
    ['HEADING', 'h3'],
    ['PARAGRAPH', 'p'],
    ['DIVIDER', 'hr'],
  ] as const)('renders %s as <%s> with no form control', (type, tag) => {
    const element = buildField(field({ type }), null);

    expect(element.tagName.toLowerCase()).toBe(tag);
    // A `<label for>` pointing at nothing is an accessibility error, not just
    // redundant markup.
    expect(element.querySelector('label')).toBeNull();
  });
});

describe('buildField hidden fields', () => {
  it('hides a HIDDEN field from the layout', () => {
    const wrapper = buildField(field({ type: 'HIDDEN' }), 'utm-value');
    expect(wrapper.hasAttribute('hidden')).toBe(true);
  });

  it('hides a field flagged hidden regardless of type', () => {
    expect(buildField(field({ hidden: true }), null).hasAttribute('hidden')).toBe(true);
  });
});

describe('buildField escaping', () => {
  /**
   * A merchant is not an attacker, but a label is still untrusted input
   * crossing into markup. Using textContent rather than innerHTML means a label
   * containing a tag renders as text.
   */
  it('does not interpret markup in a merchant label', () => {
    const wrapper = buildField(field({ label: '<img src=x onerror=alert(1)>' }), null);

    expect(wrapper.querySelector('img')).toBeNull();
    expect(wrapper.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('does not interpret markup in help text', () => {
    const wrapper = buildField(field({ helpText: '<script>alert(1)</script>' }), null);
    expect(wrapper.querySelector('script')).toBeNull();
  });
});

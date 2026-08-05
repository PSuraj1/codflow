import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { localizeForm, type FormDefinition, type FormFieldDefinition } from '@codflow/shared';
import { renderWithPolaris } from './render';
import { TranslationsPanel } from '../components/builder/TranslationsPanel';

/**
 * Translating the COD form.
 *
 * Every moving part below this already existed — the `translations` columns,
 * `localizeForm`, the storefront sending `request.locale.iso_code`, and the
 * submission path localizing again before it validates. Only the authoring UI
 * was missing, so the property worth pinning is that what this panel writes is
 * exactly the shape `localizeForm` reads. The last test checks that directly,
 * against the real function rather than a copy of its rules.
 */

function field(overrides: Partial<FormFieldDefinition> = {}): FormFieldDefinition {
  return {
    id: 'f1',
    key: 'firstName',
    type: 'TEXT',
    label: 'First name',
    placeholder: 'John',
    helpText: null,
    position: 0,
    enabled: true,
    hidden: false,
    system: true,
    defaultValue: null,
    options: [],
    columnWidth: 12,
    cssClass: null,
    conditional: null,
    validation: { required: true },
    translations: {},
    ...overrides,
  } as FormFieldDefinition;
}

const COPY = {
  headingText: 'Cash On Delivery',
  subheadingText: null,
  submitButtonText: 'Place Order',
  successMessage: 'Thank you!',
};

function renderPanel(overrides: Partial<Parameters<typeof TranslationsPanel>[0]> = {}) {
  const props = {
    locales: ['HI'] as never,
    defaultLocale: 'EN' as never,
    copy: COPY,
    translations: {},
    onTranslationsChange: vi.fn(),
    fields: [field()],
    onFieldChange: vi.fn(),
    ...overrides,
  };

  renderWithPolaris(<TranslationsPanel {...props} />);
  return props;
}

describe('a shop with one language', () => {
  /** Nothing to translate, and the reason is not obvious without saying it. */
  it('says where languages come from rather than showing an empty form', () => {
    renderPanel({ locales: [] as never });

    expect(screen.getByText(/publishes one language/i)).toBeTruthy();
    expect(screen.queryByLabelText('Heading')).toBeNull();
  });
});

describe('the source text', () => {
  /**
   * Shown beside the input, not as a placeholder — a placeholder disappears the
   * moment a translator types, which is exactly when they still need it.
   */
  it('stays visible after something is typed', () => {
    renderPanel({ translations: { hi: { headingText: 'कैश ऑन डिलीवरी' } } });

    expect(screen.getByDisplayValue('कैश ऑन डिलीवरी')).toBeTruthy();
    expect(screen.getByText(/English: Cash On Delivery/)).toBeTruthy();
  });

  it('omits a sub-heading the merchant never wrote', () => {
    renderPanel();
    expect(screen.queryByLabelText('Sub-heading')).toBeNull();
  });
});

describe('editing', () => {
  it('writes form copy under the chosen language', async () => {
    const props = renderPanel();

    await userEvent.type(screen.getByLabelText('Button text'), 'X');

    expect(props.onTranslationsChange).toHaveBeenCalledWith({
      hi: { submitButtonText: 'X' },
    });
  });

  it('writes a field label onto that field, not onto the form', async () => {
    const props = renderPanel();

    await userEvent.type(screen.getByLabelText('Label'), 'न');

    expect(props.onFieldChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'f1', translations: { hi: { label: 'न' } } }),
    );
  });

  it('offers a placeholder only where one exists to translate', () => {
    renderPanel({ fields: [field({ placeholder: null })] });
    expect(screen.queryByLabelText('Placeholder')).toBeNull();
  });
});

describe('progress', () => {
  it('counts what is still untranslated', () => {
    renderPanel();
    // Four copy strings minus the absent sub-heading, plus one field.
    expect(screen.getByText('0 of 5')).toBeTruthy();
  });

  it('counts a filled string as done', () => {
    renderPanel({ translations: { hi: { headingText: 'क' } } });
    expect(screen.getByText('1 of 5')).toBeTruthy();
  });
});

describe('what the panel writes is what the storefront reads', () => {
  /**
   * The end-to-end guarantee, against the real `localizeForm` — the same
   * function the form endpoint and the submission validator both call.
   */
  it('renders the translation for the shopper’s language', () => {
    const form = {
      ...COPY,
      id: 'form_1',
      name: 'Default',
      active: true,
      isDefault: true,
      requireOtp: false,
      translations: { hi: { headingText: 'कैश ऑन डिलीवरी', submitButtonText: 'ऑर्डर करें' } },
      fields: [field({ translations: { hi: { label: 'पहला नाम' } } })],
    } as unknown as FormDefinition;

    const localized = localizeForm(form, 'hi-IN');

    expect(localized.headingText).toBe('कैश ऑन डिलीवरी');
    expect(localized.submitButtonText).toBe('ऑर्डर करें');
    expect(localized.fields[0]?.label).toBe('पहला नाम');
  });

  /** Empty means "fall back", which is why nothing needs a reset control. */
  it('falls back to the default text for anything untranslated', () => {
    const form = {
      ...COPY,
      id: 'form_1',
      name: 'Default',
      active: true,
      isDefault: true,
      requireOtp: false,
      translations: { hi: { headingText: 'कैश ऑन डिलीवरी' } },
      fields: [field()],
    } as unknown as FormDefinition;

    const localized = localizeForm(form, 'hi');

    expect(localized.submitButtonText).toBe('Place Order');
    expect(localized.fields[0]?.label).toBe('First name');
  });

  it('leaves a language with no translations entirely alone', () => {
    const form = {
      ...COPY,
      id: 'form_1',
      name: 'Default',
      active: true,
      isDefault: true,
      requireOtp: false,
      translations: { hi: { headingText: 'कैश ऑन डिलीवरी' } },
      fields: [field()],
    } as unknown as FormDefinition;

    expect(localizeForm(form, 'fr').headingText).toBe('Cash On Delivery');
  });
});

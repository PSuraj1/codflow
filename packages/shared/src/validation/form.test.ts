import { describe, expect, it } from 'vitest';
import type { FormDefinition, FormFieldDefinition } from '../contracts/forms.js';
import { checkBotSignals, localizeForm, validateForm } from './form.js';

function field(key: string, overrides: Partial<FormFieldDefinition> = {}): FormFieldDefinition {
  return {
    id: key,
    key,
    type: 'TEXT',
    label: key,
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

function form(fields: FormFieldDefinition[], overrides: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id: 'form',
    name: 'Form',
    active: true,
    isDefault: true,
    headingText: 'Cash On Delivery',
    subheadingText: null,
    submitButtonText: 'Place Order',
    successMessage: 'Thanks!',
    translations: {},
    layout: 'single_column',
    showOrderSummary: true,
    showProductImage: true,
    showQuantitySelector: true,
    showVariantSelector: true,
    showCouponField: false,
    showTermsCheckbox: false,
    termsUrl: null,
    requireOtp: false,
    trackAbandonment: true,
    abandonmentDelaySeconds: 30,
    botProtection: true,
    minFillSeconds: 3,
    fields,
    ...overrides,
  };
}

describe('validateForm', () => {
  const conditional = form([
    field('country', { validation: { required: true } }),
    field('gst', {
      validation: { required: true },
      conditional: { logic: 'all', conditions: [{ field: 'country', operator: 'equals', value: 'IN' }] },
    }),
  ]);

  /**
   * The bug this prevents is the classic one for conditional forms: the shopper
   * is told a field is required while looking at a form that does not contain
   * it, and there is no way to proceed.
   */
  it('does not validate a field hidden by a condition', () => {
    expect(validateForm(conditional, { country: 'AE' }).valid).toBe(true);
  });

  it('validates the field once its condition matches', () => {
    const result = validateForm(conditional, { country: 'IN' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.key).toBe('gst');
  });

  /**
   * A shopper who selects India, types a GST number, then switches to UAE would
   * otherwise have the now-irrelevant value written onto their order.
   */
  it('drops values for fields that ended up hidden', () => {
    const result = validateForm(conditional, { country: 'AE', gst: 'stale-value' });
    expect(Object.keys(result.values)).toEqual(['country']);
  });

  it('skips presentational fields entirely', () => {
    const withHeading = form([
      field('heading', { type: 'HEADING', validation: { required: true } }),
      field('name'),
    ]);
    expect(validateForm(withHeading, {}).valid).toBe(true);
  });

  it('skips disabled fields', () => {
    const withDisabled = form([field('x', { enabled: false, validation: { required: true } })]);
    expect(validateForm(withDisabled, {}).valid).toBe(true);
  });

  it('keys errors by field for form binding', () => {
    const required = form([field('a', { validation: { required: true } })]);
    expect(validateForm(required, {}).errorsByKey).toHaveProperty('a');
  });

  it('reports every failing field, not just the first', () => {
    const twoRequired = form([
      field('a', { validation: { required: true } }),
      field('b', { validation: { required: true } }),
    ]);
    expect(validateForm(twoRequired, {}).errors).toHaveLength(2);
  });
});

describe('checkBotSignals', () => {
  const subject = form([field('a')], { minFillSeconds: 3 });

  it('passes a normal submission', () => {
    expect(checkBotSignals(subject, '', Date.now() - 9_000).passed).toBe(true);
  });

  it('fails when the honeypot is filled', () => {
    // A human never sees this field; anything in it came from a script that
    // filled every input it found.
    expect(checkBotSignals(subject, 'spam', Date.now() - 9_000).reason).toBe('honeypot');
  });

  it('fails a submission faster than a person could type', () => {
    expect(checkBotSignals(subject, '', Date.now() - 500).reason).toBe('too_fast');
  });

  /**
   * A client clock ahead of the server's is common and harmless. Treating it as
   * a bot signal would reject real orders from anyone with a fast clock.
   */
  it('does not fail on a client clock running ahead', () => {
    expect(checkBotSignals(subject, '', Date.now() + 60_000).passed).toBe(true);
  });

  it('is inert when bot protection is off', () => {
    const off = form([field('a')], { botProtection: false });
    expect(checkBotSignals(off, 'spam', Date.now()).passed).toBe(true);
  });

  it('passes when no render timestamp is available', () => {
    expect(checkBotSignals(subject, '', null).passed).toBe(true);
  });
});

describe('localizeForm', () => {
  const subject = form(
    [
      field('phone', {
        label: 'Phone number',
        translations: { hi: { label: 'फ़ोन नंबर' } },
      }),
      field('city', { label: 'City' }),
    ],
    { headingText: 'Cash On Delivery', translations: { hi: { headingText: 'कैश ऑन डिलीवरी' } } },
  );

  it('applies translations for the requested language', () => {
    const localized = localizeForm(subject, 'hi');
    expect(localized.headingText).toBe('कैश ऑन डिलीवरी');
    expect(localized.fields[0]?.label).toBe('फ़ोन नंबर');
  });

  it('falls back to the default text when a translation is missing', () => {
    // Blank labels would be far worse than untranslated ones.
    expect(localizeForm(subject, 'hi').fields[1]?.label).toBe('City');
  });

  it('accepts a region-qualified tag', () => {
    expect(localizeForm(subject, 'hi-IN').headingText).toBe('कैश ऑन डिलीवरी');
  });

  it('leaves the form untouched for an unknown language', () => {
    expect(localizeForm(subject, 'fr').headingText).toBe('Cash On Delivery');
  });
});

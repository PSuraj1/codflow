import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FormFieldDefinition } from '@codflow/shared';
import { renderWithPolaris } from './render';
import { FormPreview } from '../components/builder/FormPreview';
import { SubmitButtonRow } from '../components/builder/SubmitButtonRow';
import { FormCopyEditor, type FormCopy } from '../components/builder/FormCopyEditor';

/**
 * The submit button in the builder.
 *
 * `submitButtonText` has always existed on `FormConfig` and has always been
 * rendered by the storefront — but no admin screen could change it, and neither
 * the field list nor the preview showed it at all. Both stopped one row short of
 * what a shopper sees, which read as the builder being unfinished.
 */

function field(overrides: Partial<FormFieldDefinition> = {}): FormFieldDefinition {
  return {
    id: 'f1',
    key: 'firstName',
    type: 'TEXT',
    label: 'First name',
    placeholder: null,
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
    ...overrides,
  } as FormFieldDefinition;
}

function copy(overrides: Partial<FormCopy> = {}): FormCopy {
  return {
    headingText: 'Cash On Delivery',
    subheadingText: null,
    submitButtonText: 'Place Order',
    successMessage: 'Thank you!',
    ...overrides,
  };
}

describe('FormPreview', () => {
  it('ends with the submit button, as the storefront does', () => {
    renderWithPolaris(<FormPreview fields={[field()]} submitButtonText="Confirm my order" />);

    expect(screen.getByRole('button', { name: 'Confirm my order' })).toBeTruthy();
  });

  /** Submitting here would create nothing; looking like it might is worse. */
  it('renders the button inert', () => {
    renderWithPolaris(<FormPreview fields={[field()]} submitButtonText="Place Order" />);

    const button = screen.getByRole('button', { name: 'Place Order' });
    expect(button.getAttribute('aria-disabled') ?? button.hasAttribute('disabled')).toBeTruthy();
  });

  it('shows no button when the caller has no copy to show', () => {
    renderWithPolaris(<FormPreview fields={[field()]} />);

    expect(screen.queryByRole('button', { name: 'Place Order' })).toBeNull();
  });
});

describe('SubmitButtonRow', () => {
  it('shows the wording the shopper will read', () => {
    renderWithPolaris(
      <SubmitButtonRow label="Confirm my order" isSelected={false} onSelect={() => undefined} />,
    );

    expect(screen.getByText('Confirm my order')).toBeTruthy();
  });

  it('opens its editor when picked', async () => {
    const onSelect = vi.fn();

    renderWithPolaris(
      <SubmitButtonRow label="Place Order" isSelected={false} onSelect={onSelect} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit the submit button' }));

    expect(onSelect).toHaveBeenCalled();
  });

  /**
   * A form with no way to submit it is not a form, so this row offers no
   * reorder, hide or delete — unlike every row above it.
   */
  it('offers no way to move, hide or remove it', () => {
    renderWithPolaris(
      <SubmitButtonRow label="Place Order" isSelected={false} onSelect={() => undefined} />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('FormCopyEditor', () => {
  it('edits the button text', async () => {
    const onChange = vi.fn();

    renderWithPolaris(<FormCopyEditor copy={copy()} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Button text'), '!');

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ submitButtonText: 'Place Order!' }),
    );
  });

  it('stores an emptied sub-heading as absent rather than blank', async () => {
    const onChange = vi.fn();

    renderWithPolaris(
      <FormCopyEditor copy={copy({ subheadingText: 'x' })} onChange={onChange} />,
    );

    await userEvent.clear(screen.getByLabelText('Sub-heading'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subheadingText: null }));
  });

  it('reaches the other copy the storefront renders', () => {
    renderWithPolaris(<FormCopyEditor copy={copy()} onChange={() => undefined} />);

    expect(screen.getByLabelText('Heading')).toBeTruthy();
    expect(screen.getByLabelText('Message after ordering')).toBeTruthy();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPolaris } from '../../tests/render';
import { ColumnMapper, type MappedColumn } from './ColumnMapper';

/**
 * The Google Sheets column mapper.
 *
 * The logic worth testing is not the markup but the two rules that keep a
 * mapping coherent: a field cannot occupy two columns, and changing a column's
 * field must not silently discard a header the merchant wrote themselves.
 */

const customFields = [{ key: 'landmark', label: 'Landmark' }];

function setup(columns: MappedColumn[]) {
  const onChange = vi.fn();

  renderWithPolaris(
    <ColumnMapper columns={columns} customFields={customFields} onChange={onChange} />,
  );

  return { onChange, user: userEvent.setup() };
}

describe('layout', () => {
  it('labels each column with its spreadsheet letter', () => {
    setup([
      { source: 'createdAt', header: 'Date' },
      { source: 'reference', header: 'Order ID' },
      { source: 'phone', header: 'Phone' },
    ]);

    expect(screen.getByText('A')).toBeDefined();
    expect(screen.getByText('B')).toBeDefined();
    expect(screen.getByText('C')).toBeDefined();
  });

  it('reports how many of the available columns are used', () => {
    setup([{ source: 'reference', header: 'Order ID' }]);
    expect(screen.getByText(/1 of 26 columns/i)).toBeDefined();
  });
});

describe('field selection', () => {
  /**
   * The server rejects a duplicate source, so offering one would produce a save
   * that fails with an error the merchant cannot act on from the grid.
   */
  it('does not offer a field already used by another column', () => {
    setup([
      { source: 'reference', header: 'Order ID' },
      { source: 'phone', header: 'Phone' },
    ]);

    const [firstSelect] = screen.getAllByRole('combobox');
    const optionValues = [...(firstSelect as HTMLSelectElement).options].map(
      (option) => option.value,
    );

    // Its own value stays, or the select would render blank.
    expect(optionValues).toContain('reference');
    expect(optionValues).not.toContain('phone');
  });

  it('offers the merchant’s own custom fields', () => {
    setup([{ source: 'reference', header: 'Order ID' }]);

    const [select] = screen.getAllByRole('combobox');
    const optionValues = [...(select as HTMLSelectElement).options].map((option) => option.value);

    expect(optionValues).toContain('customFields.landmark');
  });

  it('resets an untouched header when the field changes', async () => {
    // "Order ID" is the default header for `reference`, so it is safe to
    // replace with the new field's default.
    const { onChange, user } = setup([{ source: 'reference', header: 'Order ID' }]);

    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'phone');

    expect(onChange).toHaveBeenCalledWith([{ source: 'phone', header: 'Phone' }]);
  });

  /**
   * The behaviour that protects a merchant's work: a header they typed is not
   * a default, so a stray dropdown change must not throw it away.
   */
  it('keeps a customised header when the field changes', async () => {
    const { onChange, user } = setup([{ source: 'reference', header: 'Our Ref No.' }]);

    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'phone');

    expect(onChange).toHaveBeenCalledWith([{ source: 'phone', header: 'Our Ref No.' }]);
  });
});

describe('adding and removing columns', () => {
  it('appends a column with an unused field', async () => {
    const { onChange, user } = setup([{ source: 'createdAt', header: 'Date & Time' }]);

    await user.click(screen.getByRole('button', { name: /add column/i }));

    const [next] = onChange.mock.calls.at(-1) as [MappedColumn[]];
    expect(next).toHaveLength(2);
    expect(next[1]?.source).not.toBe('createdAt');
  });

  it('removes the chosen column', async () => {
    const { onChange, user } = setup([
      { source: 'createdAt', header: 'Date' },
      { source: 'reference', header: 'Order ID' },
    ]);

    await user.click(screen.getByRole('button', { name: /remove column b/i }));

    expect(onChange).toHaveBeenCalledWith([{ source: 'createdAt', header: 'Date' }]);
  });

  /**
   * A mapping with no columns would write empty rows into the merchant's
   * sheet, and the server rejects it — so the last one cannot be removed.
   */
  it('prevents removing the last column', async () => {
    const { onChange, user } = setup([{ source: 'reference', header: 'Order ID' }]);

    const remove = screen.getByRole('button', { name: /remove column a/i });

    // Polaris marks a disabled button with `aria-disabled` rather than the
    // native `disabled` attribute — deliberately, so it stays focusable and a
    // screen reader user can still find it and be told it is unavailable.
    expect(remove.getAttribute('aria-disabled')).toBe('true');

    // The behavioural assertion matters more than the attribute: clicking must
    // not empty the mapping.
    await user.click(remove);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('header editing', () => {
  it('passes an edited header through unchanged', async () => {
    const { onChange, user } = setup([{ source: 'reference', header: 'Order ID' }]);

    const header = screen.getByPlaceholderText('Header text');
    await user.type(header, '!');

    // Controlled input: each keystroke reports the full next value.
    expect(onChange).toHaveBeenCalledWith([{ source: 'reference', header: 'Order ID!' }]);
  });
});

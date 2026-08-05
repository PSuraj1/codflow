import { describe, expect, it } from 'vitest';
import type { FormFieldDefinition } from '../contracts/forms.js';
import { evaluateCondition, isEmpty, resolveVisibility } from './conditions.js';

/**
 * Conditional visibility.
 *
 * The stakes: the storefront uses this to decide what to draw and the API uses
 * it to decide what to validate. If the two ever disagreed, the server would
 * demand a field the shopper was never shown and the form would be impossible
 * to submit. These tests pin the behaviour both depend on.
 */

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

describe('isEmpty', () => {
  it.each([
    ['null', null, true],
    ['undefined', undefined, true],
    ['empty string', '', true],
    ['whitespace only', '   ', true],
    ['empty array', [], true],
    ['non-empty string', 'a', false],
    ['non-empty array', ['a'], false],
  ])('treats %s as empty=%s', (_label, value, expected) => {
    expect(isEmpty(value as never)).toBe(expected);
  });

  /**
   * The two that are easy to get wrong. An unticked consent box has a real
   * answer — "no" — and treating it as empty would make `is_empty` true for a
   * question the shopper deliberately answered. Zero is a real quantity.
   */
  it('does not treat false as empty', () => {
    expect(isEmpty(false)).toBe(false);
  });

  it('does not treat zero as empty', () => {
    expect(isEmpty(0)).toBe(false);
  });
});

describe('evaluateCondition', () => {
  it('compares equality across types', () => {
    // A number field posts "3" as a string; a condition authored against the
    // number 3 must still match.
    expect(evaluateCondition({ field: 'q', operator: 'equals', value: 3 }, { q: '3' })).toBe(true);
  });

  it('matches contains against array values', () => {
    expect(
      evaluateCondition({ field: 'tags', operator: 'contains', value: 'b' }, { tags: ['a', 'b'] }),
    ).toBe(true);
  });

  it('matches contains case-insensitively for strings', () => {
    expect(
      evaluateCondition({ field: 'city', operator: 'contains', value: 'PUN' }, { city: 'Pune' }),
    ).toBe(true);
  });

  it('handles in / not_in against a list', () => {
    const values = { country: 'IN' };
    expect(
      evaluateCondition({ field: 'country', operator: 'in', value: ['IN', 'AE'] }, values),
    ).toBe(true);
    expect(
      evaluateCondition({ field: 'country', operator: 'not_in', value: ['IN'] }, values),
    ).toBe(false);
  });

  /**
   * `Number('')` is 0, so an empty field would otherwise compare as less than
   * any threshold and silently satisfy a `< 100` rule.
   */
  it('never satisfies a numeric comparison with an empty value', () => {
    expect(evaluateCondition({ field: 'n', operator: 'lt', value: 100 }, { n: '' })).toBe(false);
    expect(evaluateCondition({ field: 'n', operator: 'gt', value: -1 }, { n: null })).toBe(false);
  });

  /**
   * A form authored by a newer build. Failing open leaves the field visible,
   * which is recoverable; failing closed would hide a required field with no
   * way for the shopper to proceed.
   */
  it('fails open on an unrecognised operator', () => {
    expect(
      evaluateCondition({ field: 'x', operator: 'from_the_future' as never }, { x: 'a' }),
    ).toBe(true);
  });
});

describe('resolveVisibility', () => {
  const chain = [
    field('a'),
    field('b', {
      conditional: { logic: 'all', conditions: [{ field: 'a', operator: 'equals', value: 'yes' }] },
    }),
    field('c', {
      conditional: { logic: 'all', conditions: [{ field: 'b', operator: 'is_not_empty' }] },
    }),
  ];

  it('cascades hiding down a dependency chain', () => {
    // `b` is hidden, so it contributes no value, so `c` hides too — even though
    // `b` has a value in the submission.
    expect(resolveVisibility(chain, { a: 'no', b: 'x' })).toEqual({ a: true, b: false, c: false });
  });

  it('reveals the whole chain when the root matches', () => {
    expect(resolveVisibility(chain, { a: 'yes', b: 'x' })).toEqual({ a: true, b: true, c: true });
  });

  it('respects any-logic', () => {
    const fields = [
      field('a'),
      field('b'),
      field('c', {
        conditional: {
          logic: 'any',
          conditions: [
            { field: 'a', operator: 'equals', value: '1' },
            { field: 'b', operator: 'equals', value: '2' },
          ],
        },
      }),
    ];

    expect(resolveVisibility(fields, { a: 'x', b: '2' }).c).toBe(true);
    expect(resolveVisibility(fields, { a: 'x', b: 'y' }).c).toBe(false);
  });

  it('keeps a disabled field hidden regardless of its conditions', () => {
    const fields = [field('a'), field('b', { enabled: false })];
    expect(resolveVisibility(fields, { a: 'anything' }).b).toBe(false);
  });

  /**
   * A merchant can author `A depends on B, B depends on A` in the builder. The
   * resolver is bounded by field count, so it must terminate rather than spin —
   * this runs in a shopper's browser on every keystroke.
   */
  it('terminates on a circular rule', () => {
    const circular = [
      field('x', {
        conditional: { logic: 'all', conditions: [{ field: 'y', operator: 'is_not_empty' }] },
      }),
      field('y', {
        conditional: { logic: 'all', conditions: [{ field: 'x', operator: 'is_not_empty' }] },
      }),
    ];

    const startedAt = Date.now();
    const result = resolveVisibility(circular, { x: '1', y: '1' });

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(Object.keys(result)).toEqual(['x', 'y']);
  });

  it('handles a field with no conditions as always visible', () => {
    expect(resolveVisibility([field('a')], {})).toEqual({ a: true });
  });
});

import { describe, expect, it } from 'vitest';
import { PlacementParamSchema, UpdateButtonSchema } from './dto';

/**
 * Button input validation.
 *
 * The colour fields are the reason this file exists. Each one is concatenated
 * into a `style` attribute by the theme extension — `'--codflow-bg:' + value`
 * — so any value able to carry a `;` writes arbitrary CSS declarations onto the
 * merchant's own storefront.
 */

describe('colours', () => {
  it.each(['#008060', '#fff', '#FFF', '#AbC123'])('accepts %s', (bgColor) => {
    expect(UpdateButtonSchema.safeParse({ bgColor }).success).toBe(true);
  });

  it.each([
    ['a declaration break', 'red;position:fixed;inset:0'],
    ['a named colour', 'red'],
    ['a url', 'url(https://example.com/x.png)'],
    ['a function', 'rgb(0,128,96)'],
    ['a hex without the hash', '008060'],
    ['four digits', '#0080'],
    ['empty', ''],
  ])('rejects %s', (_label, bgColor) => {
    expect(UpdateButtonSchema.safeParse({ bgColor }).success).toBe(false);
  });

  it('applies the same rule to every colour field', () => {
    for (const field of ['bgColor', 'textColor', 'borderColor']) {
      expect(UpdateButtonSchema.safeParse({ [field]: 'red;x:y' }).success).toBe(false);
    }
  });
});

describe('placement', () => {
  it.each(['PRODUCT_PAGE', 'CART_PAGE', 'COLLECTION_PAGE', 'HOME_PAGE', 'STICKY_MOBILE', 'FLOATING'])(
    'accepts %s',
    (placement) => {
      expect(PlacementParamSchema.safeParse({ placement }).success).toBe(true);
    },
  );

  /** A real column value with nothing that renders it. */
  it('rejects POPUP', () => {
    expect(PlacementParamSchema.safeParse({ placement: 'POPUP' }).success).toBe(false);
  });
});

describe('label', () => {
  it('rejects an empty label', () => {
    expect(UpdateButtonSchema.safeParse({ label: '   ' }).success).toBe(false);
  });

  it('rejects a label too long to render as a button', () => {
    expect(UpdateButtonSchema.safeParse({ label: 'a'.repeat(61) }).success).toBe(false);
  });

  it('allows the sub-label to be cleared', () => {
    expect(UpdateButtonSchema.safeParse({ subLabel: null }).success).toBe(true);
  });
});

describe('enumerated values', () => {
  it('rejects an animation with no stylesheet rule behind it', () => {
    expect(UpdateButtonSchema.safeParse({ animation: 'bounce' }).success).toBe(false);
  });

  it('rejects a floating position the extension does not style', () => {
    expect(UpdateButtonSchema.safeParse({ floatingPosition: 'top_left' }).success).toBe(false);
  });

  it('rejects a font weight outside the offered set', () => {
    expect(UpdateButtonSchema.safeParse({ fontWeight: '350' }).success).toBe(false);
  });
});

describe('an empty patch', () => {
  /** Saving nothing is a no-op, not an error — the UI sends what changed. */
  it('is accepted', () => {
    expect(UpdateButtonSchema.safeParse({}).success).toBe(true);
  });
});

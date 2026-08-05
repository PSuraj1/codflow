import { describe, expect, it } from 'vitest';
import { ImportSettingsSchema } from './dto';

/**
 * The import boundary.
 *
 * An uploaded settings file is untrusted input that writes many columns at
 * once, which makes this schema the security boundary of the whole feature.
 * Two properties carry the weight, and both are about what must *not* get
 * through: a file cannot name a column the schema does not list, and it cannot
 * reach a validation rule the admin screens enforce.
 */

const file = (over: Record<string, unknown> = {}) => ({ version: 1, ...over });

describe('envelope', () => {
  it('accepts a minimal file', () => {
    expect(ImportSettingsSchema.safeParse(file()).success).toBe(true);
  });

  it('requires a version', () => {
    expect(ImportSettingsSchema.safeParse({ settings: {} }).success).toBe(false);
  });

  /**
   * Provenance a merchant can read, never a target. The shop written to comes
   * from the session, so this being present must not imply anything.
   */
  it('keeps the source domain but never a shop id', () => {
    const parsed = ImportSettingsSchema.safeParse(
      file({ shopDomain: 'other.myshopify.com', shopId: 'shop_123' }),
    );

    expect(parsed.success && parsed.data.shopDomain).toBe('other.myshopify.com');
    expect(parsed.success && 'shopId' in parsed.data).toBe(false);
  });
});

/**
 * The reason the schema is an allow-list. A deny-list is correct only until the
 * next migration adds a column nobody remembered to exclude.
 */
describe('secrets and identity cannot ride along', () => {
  it.each([
    'ipIntelApiKeyEnc',
    'accessTokenEnc',
    'refreshTokenEnc',
    'msg91AuthKeyEnc',
    'twilioAuthTokenEnc',
  ])('strips %s from fraud settings', (key) => {
    const parsed = ImportSettingsSchema.safeParse(file({ fraud: { [key]: 'secret-value' } }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && key in (parsed.data.fraud ?? {})).toBe(false);
  });

  it.each(['id', 'shopId', 'createdAt', 'updatedAt'])('strips %s from settings', (key) => {
    const parsed = ImportSettingsSchema.safeParse(file({ settings: { [key]: 'x' } }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && key in (parsed.data.settings ?? {})).toBe(false);
  });

  it('strips a column added by a future migration', () => {
    const parsed = ImportSettingsSchema.safeParse(file({ settings: { somethingNew: true } }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && 'somethingNew' in (parsed.data.settings ?? {})).toBe(false);
  });
});

/** An import must not be a route around the checks the screens enforce. */
describe('bounds match the admin', () => {
  it.each([
    ['a colour that breaks out of the style attribute', { brandPrimaryColor: 'red;position:fixed' }],
    ['a named colour', { brandPrimaryColor: 'red' }],
    ['money as a number', { shippingFee: 499 }],
    ['money with three decimals', { shippingFee: '499.999' }],
    ['a logo over http', { brandLogoUrl: 'http://x.test/l.png' }],
    ['a logo height above the slider', { brandLogoHeight: 400 }],
    ['an unknown logo alignment', { brandLogoAlignment: 'middle' }],
    ['a retention period below the floor', { orderRetentionDays: 1 }],
    ['an unknown inventory behaviour', { inventoryBehaviour: 'delete_everything' }],
    ['a non-Shopify gid', { excludedProductGids: ['gid://evil/Product/1'] }],
  ])('rejects %s', (_label, settings) => {
    expect(ImportSettingsSchema.safeParse(file({ settings })).success).toBe(false);
  });

  it('rejects a colour on a button too', () => {
    const parsed = ImportSettingsSchema.safeParse(
      file({ buttons: [{ placement: 'PRODUCT_PAGE', bgColor: 'url(x)' }] }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown placement', () => {
    expect(
      ImportSettingsSchema.safeParse(file({ buttons: [{ placement: 'CHECKOUT' }] })).success,
    ).toBe(false);
  });
});

/** A file from a shop with more rows than the app can hold is a denial of service. */
describe('size limits', () => {
  it('rejects more buttons than there are placements', () => {
    const buttons = Array.from({ length: 7 }, () => ({ placement: 'PRODUCT_PAGE' }));
    expect(ImportSettingsSchema.safeParse(file({ buttons })).success).toBe(false);
  });

  it('rejects an unbounded rule list', () => {
    const fraudRules = Array.from({ length: 101 }, (_, i) => ({ name: `r${i}`, conditions: {} }));
    expect(ImportSettingsSchema.safeParse(file({ fraudRules })).success).toBe(false);
  });

  it('rejects an unbounded field list', () => {
    const fields = Array.from({ length: 61 }, (_, i) => ({
      key: `f${i}`,
      type: 'TEXT',
      label: 'x',
      position: i,
    }));

    expect(ImportSettingsSchema.safeParse(file({ forms: [{ name: 'F', fields }] })).success).toBe(
      false,
    );
  });
});

/**
 * A partial file is normal: an older export, or one a merchant trimmed to the
 * screens they cared about. Absent means "leave it alone".
 */
describe('partial files', () => {
  it('accepts settings with one field', () => {
    const parsed = ImportSettingsSchema.safeParse(file({ settings: { codEnabled: false } }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data.settings ?? {})).toEqual(['codEnabled']);
  });

  it('accepts a button carrying only its placement', () => {
    expect(
      ImportSettingsSchema.safeParse(file({ buttons: [{ placement: 'FLOATING' }] })).success,
    ).toBe(true);
  });

  it('accepts a null fraud section', () => {
    expect(ImportSettingsSchema.safeParse(file({ fraud: null })).success).toBe(true);
  });
});

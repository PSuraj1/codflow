import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * COD button configuration.
 *
 * Three properties, each of which fails silently on a storefront if it breaks:
 *
 *  - Every renderable placement is listed, including the two with no row. A
 *    merchant whose app block is set to "Home page" has nothing to configure
 *    otherwise, and their slot never fills.
 *  - A partial save writes the whole record. On the create branch the columns
 *    a merchant did not mention would take the schema defaults — and
 *    `isEnabled` defaults to `true` there, so saving a colour would switch a
 *    placement on.
 *  - A button that is on but hidden on both viewports is refused. The theme
 *    renders nothing and reports nothing, which looks exactly like the app
 *    being broken.
 */

const { listButtons, findButton, upsertButton } = vi.hoisted(() => ({
  listButtons: vi.fn(),
  findButton: vi.fn(),
  upsertButton: vi.fn(),
}));
const { assertFeature } = vi.hoisted(() => ({ assertFeature: vi.fn() }));
const { invalidateTag } = vi.hoisted(() => ({ invalidateTag: vi.fn() }));

vi.mock('./repository', () => ({ listButtons, findButton, upsertButton }));
vi.mock('../billing/limits', () => ({ assertFeature }));
vi.mock('../../lib/cache', () => ({ invalidateTag, shopTag: (domain: string) => `shop:${domain}` }));
vi.mock('../../db/prisma', () => ({ prisma: {} }));

const service = await import('./service');
const { DEFAULT_BUTTON_STYLE } = await import('../shop/defaults');

/** A persisted row, in the shape Prisma returns it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'btn_1',
    shopId: 'shop_1',
    placement: 'PRODUCT_PAGE',
    ...DEFAULT_BUTTON_STYLE,
    isEnabled: true,
    translations: {},
    iconName: null,
    openInPopup: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listButtons.mockResolvedValue([]);
  findButton.mockResolvedValue(null);
  upsertButton.mockImplementation((_shopId: string, placement: string, record: object) =>
    Promise.resolve(row({ placement, ...record })),
  );
});

describe('listButtons', () => {
  it('lists every renderable placement when the shop has no rows at all', async () => {
    const buttons = await service.listButtons('shop_1');

    expect(buttons.map((button) => button.placement)).toEqual([
      'PRODUCT_PAGE',
      'CART_PAGE',
      'COLLECTION_PAGE',
      'HOME_PAGE',
      'STICKY_MOBILE',
      'FLOATING',
    ]);
  });

  it('reports an unconfigured placement as off, not as the schema default', async () => {
    const buttons = await service.listButtons('shop_1');
    const homePage = buttons.find((button) => button.placement === 'HOME_PAGE');

    // The column defaults to true, but without a row the storefront query
    // returns nothing — so off is what the shopper is actually seeing.
    expect(homePage?.isEnabled).toBe(false);
  });

  it('drops a placement nothing renders', async () => {
    listButtons.mockResolvedValue([row({ placement: 'POPUP' })]);

    const buttons = await service.listButtons('shop_1');

    expect(buttons.some((button) => button.placement === 'POPUP')).toBe(false);
  });

  it('prefers a persisted row over the defaults', async () => {
    listButtons.mockResolvedValue([row({ label: 'Pay at your door', isEnabled: true })]);

    const buttons = await service.listButtons('shop_1');
    const product = buttons.find((button) => button.placement === 'PRODUCT_PAGE');

    expect(product?.label).toBe('Pay at your door');
    expect(product?.isEnabled).toBe(true);
  });
});

describe('updateButton', () => {
  it('does not switch on a placement that had no row', async () => {
    await service.updateButton('shop_1', 'test.myshopify.com', 'HOME_PAGE', {
      bgColor: '#112233',
    });

    expect(upsertButton).toHaveBeenCalledWith(
      'shop_1',
      'HOME_PAGE',
      expect.objectContaining({ bgColor: '#112233', isEnabled: false }),
    );
  });

  it('carries every unmentioned field into the write', async () => {
    await service.updateButton('shop_1', 'test.myshopify.com', 'HOME_PAGE', { fontSize: 20 });

    const record = upsertButton.mock.calls[0]?.[2] as Record<string, unknown>;

    expect(record.fontSize).toBe(20);
    expect(record.label).toBe(DEFAULT_BUTTON_STYLE.label);
    expect(record.paddingX).toBe(DEFAULT_BUTTON_STYLE.paddingX);
  });

  it('keeps the fields it was not given on a placement that has a row', async () => {
    findButton.mockResolvedValue(row({ label: 'Pay at your door', fontSize: 22 }));

    await service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', {
      bgColor: '#000000',
    });

    expect(upsertButton).toHaveBeenCalledWith(
      'shop_1',
      'PRODUCT_PAGE',
      expect.objectContaining({ label: 'Pay at your door', fontSize: 22, bgColor: '#000000' }),
    );
  });

  it('refuses a button that is on but hidden on every viewport', async () => {
    findButton.mockResolvedValue(row({ isEnabled: true, showOnMobile: false }));

    await expect(
      service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', {
        showOnDesktop: false,
      }),
    ).rejects.toThrow(/never appear/);

    expect(upsertButton).not.toHaveBeenCalled();
  });

  it('allows both viewports off while the button itself is off', async () => {
    findButton.mockResolvedValue(row({ isEnabled: false, showOnMobile: false }));

    await expect(
      service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', {
        showOnDesktop: false,
      }),
    ).resolves.toBeDefined();
  });

  it('stores an emptied sub-label as absent rather than blank', async () => {
    findButton.mockResolvedValue(row({ subLabel: 'Pay on delivery' }));

    await service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', { subLabel: '' });

    expect(upsertButton).toHaveBeenCalledWith(
      'shop_1',
      'PRODUCT_PAGE',
      expect.objectContaining({ subLabel: null }),
    );
  });

  it('checks the plan when custom CSS is added', async () => {
    await service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', {
      customCss: '.codflow-button { letter-spacing: 1px }',
    });

    expect(assertFeature).toHaveBeenCalledWith('shop_1', 'customCss');
  });

  it('does not check the plan for an edit that leaves existing CSS alone', async () => {
    findButton.mockResolvedValue(row({ customCss: '.codflow-button { letter-spacing: 1px }' }));

    // A merchant who downgraded keeps their CSS — the storefront stops serving
    // it — and must still be able to change their label.
    await service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', {
      label: 'Cash on delivery',
    });

    expect(assertFeature).not.toHaveBeenCalled();
  });

  it('invalidates the storefront cache so shoppers see the change', async () => {
    await service.updateButton('shop_1', 'test.myshopify.com', 'PRODUCT_PAGE', { fontSize: 18 });

    expect(invalidateTag).toHaveBeenCalledWith('shop:test.myshopify.com');
  });
});

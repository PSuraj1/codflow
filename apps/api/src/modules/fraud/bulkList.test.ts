import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wholesale block list replacement.
 *
 * The properties that matter are all about *not* churning rows. A merchant
 * pasting a spreadsheet column over their existing list has usually changed two
 * lines out of four hundred, and a naive delete-then-recreate would throw away
 * every `hitCount` — the only evidence they have that a rule is working.
 *
 * Normalization is what makes that possible, and it is also the thing most
 * likely to break silently: a stored `+919876543210` and a pasted
 * `+91 98765 43210` are the same entry, and treating them as different would
 * remove one and add the other on every single save.
 */

const { listScope, deleteFromScope, upsertBlockListEntry } = vi.hoisted(() => ({
  listScope: vi.fn(),
  deleteFromScope: vi.fn(),
  upsertBlockListEntry: vi.fn(),
}));

vi.mock('./repository', () => ({ listScope, deleteFromScope, upsertBlockListEntry }));
vi.mock('../../db/prisma', () => ({ prisma: {} }));
vi.mock('../../queue/queues', () => ({ enqueueFraudScanBulk: vi.fn() }));
vi.mock('../orders/repository', () => ({}));

const service = await import('./service');
const { BlockListScope, BlockListType } = await import('@prisma/client');

function stored(value: string) {
  return { id: `e-${value}`, value, type: BlockListType.BLACKLIST, scope: BlockListScope.PHONE };
}

beforeEach(() => {
  vi.clearAllMocks();
  listScope.mockResolvedValue([]);
  deleteFromScope.mockResolvedValue(0);
  upsertBlockListEntry.mockResolvedValue({});
});

describe('replaceBlockList', () => {
  it('adds the values that are new', async () => {
    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      ['+919876543210', '+919812345678'],
    );

    expect(result).toMatchObject({ total: 2, added: 2, removed: 0 });
    expect(upsertBlockListEntry).toHaveBeenCalledTimes(2);
  });

  it('removes the values the merchant deleted', async () => {
    listScope.mockResolvedValue([stored('+919876543210'), stored('+919812345678')]);
    deleteFromScope.mockResolvedValue(1);

    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      ['+919876543210'],
    );

    expect(deleteFromScope).toHaveBeenCalledWith(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      ['+919812345678'],
    );
    expect(result.removed).toBe(1);
  });

  /** The one that protects `hitCount` and `lastHitAt`. */
  it('leaves an unchanged entry completely alone', async () => {
    listScope.mockResolvedValue([stored('+919876543210')]);

    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      ['+919876543210'],
    );

    expect(upsertBlockListEntry).not.toHaveBeenCalled();
    expect(deleteFromScope).toHaveBeenCalledWith(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      [],
    );
    expect(result).toMatchObject({ added: 0, removed: 0, total: 1 });
  });

  /**
   * A merchant re-pasting the same numbers in a friendlier format must not
   * churn every row — the stored form and the pasted form are the same entry.
   */
  it('treats a differently formatted number as unchanged', async () => {
    listScope.mockResolvedValue([stored('+919876543210')]);

    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      ['+91 98765 43210'],
    );

    expect(upsertBlockListEntry).not.toHaveBeenCalled();
    expect(result).toMatchObject({ added: 0, removed: 0 });
  });

  it('lower-cases emails so case is not a second entry', async () => {
    await service.replaceBlockList('shop_1', BlockListType.BLACKLIST, BlockListScope.EMAIL, [
      'Someone@Example.COM',
    ]);

    expect(upsertBlockListEntry).toHaveBeenCalledWith(
      'shop_1',
      expect.objectContaining({ value: 'someone@example.com' }),
    );
  });

  it('collapses duplicate lines and reports how many', async () => {
    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.EMAIL,
      ['a@example.com', 'A@example.com', 'b@example.com'],
    );

    expect(result).toMatchObject({ total: 2, added: 2, duplicates: 1 });
  });

  it('drops blank lines rather than storing empty entries', async () => {
    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.EMAIL,
      ['a@example.com', '   ', ''],
    );

    expect(result.total).toBe(1);
  });

  /** Clearing the box is a legitimate edit, not a no-op to be ignored. */
  it('empties the list when every line is removed', async () => {
    listScope.mockResolvedValue([stored('+919876543210')]);
    deleteFromScope.mockResolvedValue(1);

    const result = await service.replaceBlockList(
      'shop_1',
      BlockListType.BLACKLIST,
      BlockListScope.PHONE,
      [],
    );

    expect(result).toMatchObject({ total: 0, removed: 1 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FraudSettings } from '@prisma/client';
import type { FraudSubject } from './types';

/**
 * The quantity and per-device checks.
 *
 * Both are off by default, and that is the property most worth guarding. There
 * is no sensible default order size — a wholesaler's routine order is a warning
 * sign for a boutique — and a fingerprint is not an identity, so a shared family
 * tablet placing two orders must not be treated as one person cycling numbers.
 * Shipping either one switched on would refuse real orders on day one.
 */

const { countByDevice } = vi.hoisted(() => ({ countByDevice: vi.fn() }));

vi.mock('./repository', () => ({
  countByDevice,
  countByPhone: vi.fn().mockResolvedValue(0),
  countByEmail: vi.fn().mockResolvedValue(0),
  countByIp: vi.fn().mockResolvedValue(0),
  countByAddress: vi.fn().mockResolvedValue(0),
  countOpenOrders: vi.fn().mockResolvedValue(0),
  countPriorFailures: vi.fn().mockResolvedValue({ cancelled: 0, returned: 0 }),
  findBlockListMatches: vi.fn().mockResolvedValue([]),
  recordBlockListHits: vi.fn(),
}));
vi.mock('../../db/prisma', () => ({ prisma: {} }));

const { quantityDetector, velocityDetector } = await import('./detectors');

function settings(overrides: Partial<FraudSettings> = {}): FraudSettings {
  return {
    maxItemsPerOrder: 0,
    checkVelocity: true,
    checkDeviceVelocity: false,
    maxOrdersPerDayPerDevice: 3,
    maxOrdersPerDayPerPhone: 3,
    maxOrdersPerDayPerIp: 5,
    maxOrdersPerDayPerEmail: 3,
    velocityWindowMinutes: 60,
    velocityMaxOrders: 3,
    ...overrides,
  } as FraudSettings;
}

function subject(overrides: Partial<FraudSubject> = {}): FraudSubject {
  return {
    shopId: 'shop_1',
    codOrderId: null,
    itemQuantity: 1,
    deviceFingerprint: null,
    phoneE164: null,
    email: null,
    ipAddress: null,
    ...overrides,
  } as FraudSubject;
}

const context = (s: FraudSettings, subj: FraudSubject) => ({
  subject: subj,
  settings: s,
  ipIntel: {} as never,
  now: new Date('2026-08-01T00:00:00Z'),
});

beforeEach(() => {
  vi.clearAllMocks();
  countByDevice.mockResolvedValue(0);
});

describe('the quantity check', () => {
  /** Zero is off, not a limit of zero — which would refuse every order. */
  it('is silent until the merchant sets a limit', async () => {
    const signals = await quantityDetector(
      context(settings({ maxItemsPerOrder: 0 }), subject({ itemQuantity: 500 })),
    );

    expect(signals).toEqual([]);
  });

  it('says nothing about an order within the limit', async () => {
    const signals = await quantityDetector(
      context(settings({ maxItemsPerOrder: 10 }), subject({ itemQuantity: 10 })),
    );

    expect(signals).toEqual([]);
  });

  it('fires once the limit is exceeded', async () => {
    const signals = await quantityDetector(
      context(settings({ maxItemsPerOrder: 10 }), subject({ itemQuantity: 11 })),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.code).toBe('EXCESSIVE_QUANTITY');
    expect(signals[0]?.weight).toBeGreaterThan(0);
  });

  /**
   * Units, not lines. One line of forty is the case a line count misses
   * entirely, and it is the one that matters.
   */
  it('counts units rather than lines', async () => {
    const signals = await quantityDetector(
      context(settings({ maxItemsPerOrder: 10 }), subject({ itemQuantity: 40, itemCount: 1 })),
    );

    expect(signals).toHaveLength(1);
  });
});

describe('the per-device check', () => {
  it('does not run until switched on', async () => {
    await velocityDetector(
      context(
        settings({ checkDeviceVelocity: false }),
        subject({ deviceFingerprint: 'fp-1' }),
      ),
    );

    expect(countByDevice).not.toHaveBeenCalled();
  });

  /** A missing fingerprint must not group every anonymous shopper together. */
  it('does not run without a fingerprint', async () => {
    await velocityDetector(
      context(settings({ checkDeviceVelocity: true }), subject({ deviceFingerprint: null })),
    );

    expect(countByDevice).not.toHaveBeenCalled();
  });

  it('flags a device over the daily limit', async () => {
    countByDevice.mockResolvedValue(4);

    const signals = await velocityDetector(
      context(
        settings({ checkDeviceVelocity: true, maxOrdersPerDayPerDevice: 3 }),
        subject({ deviceFingerprint: 'fp-1' }),
      ),
    );

    expect(signals.map((entry) => entry.code)).toContain('DAILY_LIMIT_DEVICE');
  });

  it('stays quiet for a device under the limit', async () => {
    countByDevice.mockResolvedValue(1);

    const signals = await velocityDetector(
      context(
        settings({ checkDeviceVelocity: true, maxOrdersPerDayPerDevice: 3 }),
        subject({ deviceFingerprint: 'fp-1' }),
      ),
    );

    expect(signals.map((entry) => entry.code)).not.toContain('DAILY_LIMIT_DEVICE');
  });
});

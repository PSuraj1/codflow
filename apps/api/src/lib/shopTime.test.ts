import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  eachDay,
  endOfShopDay,
  fromDateColumn,
  isValidTimezone,
  resolveTimezone,
  startOfMonth,
  startOfShopDay,
  toDateColumn,
  toShopDate,
} from './shopTime';

/**
 * Shop-timezone day boundaries.
 *
 * Every number on the analytics dashboard is bucketed by these functions, so a
 * fault here is not a rendering bug — it moves orders between days and makes
 * the app's totals disagree with Shopify's. The cases below are the ones that
 * actually break naive implementations: half-hour zones, a zone west of UTC,
 * and both DST transitions, where a day is not 24 hours long.
 */

describe('toShopDate', () => {
  it('keeps a late-evening order on the merchant’s own day', () => {
    // 18:35 UTC is 00:05 on the 4th in Delhi — the order the merchant took
    // just before closing.
    const instant = new Date('2026-03-03T18:35:00Z');

    expect(toShopDate(instant, 'Asia/Kolkata')).toBe('2026-03-04');
    expect(toShopDate(instant, 'UTC')).toBe('2026-03-03');
  });

  it('handles zones behind UTC', () => {
    const instant = new Date('2026-03-04T03:00:00Z');

    expect(toShopDate(instant, 'America/New_York')).toBe('2026-03-03');
  });

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    expect(toShopDate(new Date('2026-03-04T03:00:00Z'), 'Mars/Olympus')).toBe('2026-03-04');
  });
});

describe('startOfShopDay', () => {
  it('resolves a whole-hour zone', () => {
    expect(startOfShopDay('2026-03-04', 'UTC').toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(startOfShopDay('2026-03-04', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-03T23:00:00.000Z',
    );
  });

  it('resolves a half-hour zone', () => {
    // The case offset arithmetic gets wrong when someone assumes whole hours.
    expect(startOfShopDay('2026-03-04', 'Asia/Kolkata').toISOString()).toBe(
      '2026-03-03T18:30:00.000Z',
    );
  });

  it('resolves a three-quarter-hour zone', () => {
    expect(startOfShopDay('2026-03-04', 'Asia/Kathmandu').toISOString()).toBe(
      '2026-03-03T18:15:00.000Z',
    );
  });

  it('lands on real midnight either side of a spring-forward', () => {
    // US DST begins 2026-03-08. Both days must still start at local midnight.
    expect(startOfShopDay('2026-03-07', 'America/New_York').toISOString()).toBe(
      '2026-03-07T05:00:00.000Z',
    );
    expect(startOfShopDay('2026-03-09', 'America/New_York').toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });
});

describe('endOfShopDay', () => {
  it('is the next day’s midnight, not start plus 24 hours', () => {
    // The spring-forward day is 23 hours long. A `+24h` implementation would
    // reach 01:00 the following day and double-count an hour of orders.
    const start = startOfShopDay('2026-03-08', 'America/New_York');
    const end = endOfShopDay('2026-03-08', 'America/New_York');

    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('is 25 hours long on the autumn transition', () => {
    const start = startOfShopDay('2026-11-01', 'America/New_York');
    const end = endOfShopDay('2026-11-01', 'America/New_York');

    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });

  it('is exclusive, so consecutive days do not overlap', () => {
    expect(endOfShopDay('2026-03-04', 'Asia/Kolkata').getTime()).toBe(
      startOfShopDay('2026-03-05', 'Asia/Kolkata').getTime(),
    );
  });
});

describe('calendar arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('handles a leap year', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('counts both ends of a range', () => {
    expect(daysBetween('2026-03-01', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-03-07')).toBe(7);
  });

  it('enumerates a range in order', () => {
    expect(eachDay('2026-03-01', '2026-03-04')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
  });

  it('returns nothing when the range is inverted', () => {
    expect(eachDay('2026-03-04', '2026-03-01')).toEqual([]);
  });

  it('finds the first of the month', () => {
    expect(startOfMonth('2026-03-17')).toBe('2026-03-01');
  });
});

describe('date column', () => {
  it('round-trips through the Postgres date representation', () => {
    const column = toDateColumn('2026-03-04');

    // Pinned to UTC midnight so the same calendar day is one row for every
    // shop, whichever side of UTC they sit on.
    expect(column.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(fromDateColumn(column)).toBe('2026-03-04');
  });
});

describe('timezone resolution', () => {
  it('accepts an IANA zone', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(resolveTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  it('rejects nonsense and nulls without throwing', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(resolveTimezone(undefined)).toBe('UTC');
  });
});

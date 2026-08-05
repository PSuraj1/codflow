/**
 * Calendar days in a shop's own timezone.
 *
 * Every analytics bucket is a *shop day*, not a UTC day. A merchant in Delhi
 * who takes an order at 23:59 IST expects it in today's total; bucketing on UTC
 * puts it in tomorrow's, and the dashboard then disagrees with the order list
 * Shopify shows them — which reads as the app losing orders.
 *
 * Implemented on `Intl.DateTimeFormat` rather than a date library. Node ships
 * full ICU since v13, so the zone database is already in the process, and a
 * dependency here would be a second copy of the same table with its own update
 * cadence. The one thing this file must never do is arithmetic on offsets:
 * `+05:30` is not a constant for any zone with DST, and "add 24 hours to get
 * tomorrow" is wrong twice a year in most of the world.
 */

/** `YYYY-MM-DD`, the form every date crosses the wire in. */
export type IsoDate = string;

const DATE_PARTS = new Map<string, Intl.DateTimeFormat>();

/**
 * Formatters are expensive to construct and are constructed per request, so
 * they are cached by zone. A shop's zone never changes within a process, and
 * the map is bounded by the number of distinct zones the instance serves.
 */
function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = DATE_PARTS.get(timezone);
  if (cached) return cached;

  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  DATE_PARTS.set(timezone, created);
  return created;
}

/**
 * Whether a zone name is one this runtime knows.
 *
 * Shopify sends IANA names, but a shop row can hold a stale one — zones are
 * renamed (`Asia/Calcutta` → `Asia/Kolkata`, `Europe/Kiev` → `Europe/Kyiv`) and
 * an unknown name makes `Intl` throw a `RangeError` from inside a formatter,
 * which would take down the dashboard rather than mis-bucket one day.
 */
export function isValidTimezone(timezone: string | null | undefined): boolean {
  if (!timezone) return false;

  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** The shop's zone, or UTC when it is missing or unrecognised. */
export function resolveTimezone(timezone: string | null | undefined): string {
  return isValidTimezone(timezone) ? (timezone as string) : 'UTC';
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(instant: Date, timezone: string): ZonedParts {
  const parts = formatter(timezone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `en-CA` with hour12:false renders midnight as 24 in some ICU versions.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The calendar date an instant falls on, in the given zone. */
export function toShopDate(instant: Date, timezone: string): IsoDate {
  const { year, month, day } = partsIn(instant, resolveTimezone(timezone));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The UTC instant a shop day begins at.
 *
 * Found by inverting the formatter rather than by adding an offset: format a
 * guess, measure how far the result is from the target wall-clock time, and
 * correct. Two passes converge for every zone including the half-hour and
 * three-quarter-hour ones, and — unlike offset arithmetic — it stays correct
 * across a DST boundary, where the day is 23 or 25 hours long.
 */
export function startOfShopDay(date: IsoDate, timezone: string): Date {
  const zone = resolveTimezone(timezone);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];

  // First guess: the same wall-clock reading interpreted as UTC.
  let guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

  for (let pass = 0; pass < 2; pass += 1) {
    const seen = partsIn(guess, zone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    const wantedAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
    const drift = seenAsUtc - wantedAsUtc;

    if (drift === 0) break;
    guess = new Date(guess.getTime() - drift);
  }

  return guess;
}

/**
 * The exclusive end of a shop day.
 *
 * Derived as the start of the following calendar date rather than "start plus
 * 24 hours", so a spring-forward day is 23 hours and an autumn one is 25 —
 * which is what makes a `>= start AND < end` query count exactly the orders the
 * merchant saw on that date.
 */
export function endOfShopDay(date: IsoDate, timezone: string): Date {
  return startOfShopDay(addDays(date, 1), timezone);
}

/**
 * Adds days to a calendar date.
 *
 * Pure calendar arithmetic on the date itself, with no zone involved — this is
 * what "the next day" means on a wall calendar, and it is the only definition
 * that survives DST. Going through a timestamp would be the classic bug.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `from` to `to`, inclusive of both ends. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const parse = (value: IsoDate): number => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, day);
  };

  return Math.round((parse(to) - parse(from)) / 86_400_000) + 1;
}

/** Every date from `from` to `to` inclusive, ascending. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const total = daysBetween(from, to);
  if (total <= 0) return [];

  const dates: IsoDate[] = [];
  for (let index = 0; index < total; index += 1) {
    dates.push(addDays(from, index));
  }

  return dates;
}

/** Today's date in the shop's zone. */
export function shopToday(timezone: string, now: Date = new Date()): IsoDate {
  return toShopDate(now, timezone);
}

/**
 * The date column value for a `DailyStat` row.
 *
 * The column is `@db.Date`, which Prisma reads and writes as a `Date` pinned to
 * UTC midnight. Storing the *shop's* midnight instant there instead would make
 * the same calendar day land on two different values for shops either side of
 * UTC, and `@@unique([shopId, date])` would stop deduplicating.
 */
export function toDateColumn(date: IsoDate): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

/** Inverse of `toDateColumn`. */
export function fromDateColumn(value: Date): IsoDate {
  return `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(
    value.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

/** First day of the month a date falls in. */
export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

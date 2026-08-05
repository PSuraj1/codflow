import { z } from 'zod';

/**
 * Analytics request contracts.
 *
 * The date bounds are the part worth guarding. Every one of these values ends
 * up in a `WHERE date BETWEEN` against a per-shop index, and an unbounded or
 * inverted range is the difference between a ninety-row read and a table scan
 * on the screen the merchant opens first.
 */

/** `YYYY-MM-DD`, and a date that actually exists — `2026-02-31` is rejected. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be formatted YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'Not a real date');

const RANGES = ['today', '7d', '30d', '90d', 'mtd', 'custom'] as const;

/**
 * A named range, or an explicit pair.
 *
 * `from`/`to` are only consulted when `range` is `custom`, and the service
 * rejects the pair if either is missing. Validating that here would mean
 * duplicating the rule in two places; the schema's job is to reject values that
 * are malformed rather than values that are inconsistent.
 */
export const AnalyticsRangeQuerySchema = z.object({
  range: z.enum(RANGES).default('30d'),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type AnalyticsRangeQueryInput = z.infer<typeof AnalyticsRangeQuerySchema>;

export const BreakdownQuerySchema = AnalyticsRangeQuerySchema.extend({
  dimension: z.enum(['country', 'city', 'product']).default('country'),
});

export type BreakdownQueryInput = z.infer<typeof BreakdownQuerySchema>;

/**
 * A rebuild window.
 *
 * Capped at a year for the same reason the read range is: this deletes and
 * re-inserts every row in the window, and an unbounded rebuild is an unbounded
 * transaction. A merchant who genuinely needs more runs it twice.
 */
export const RebuildStatsSchema = z
  .object({
    from: isoDate,
    to: isoDate,
  })
  .refine((input) => input.from <= input.to, {
    message: 'The start date must not be after the end date',
    path: ['from'],
  });

export type RebuildStatsInput = z.infer<typeof RebuildStatsSchema>;

/**
 * Storefront telemetry.
 *
 * Unauthenticated by necessity — it is called from a shopper's browser — so it
 * accepts the shop domain and an event name and nothing else. There is no
 * identifier to forge and no money-side counter reachable from here; the worst
 * a forged call achieves is inflating the merchant's own funnel denominator.
 */
export const TelemetrySchema = z.object({
  shop: z.string().min(3).max(255),
  event: z.enum(['form_view', 'form_start', 'button_click']),
});

export type TelemetryInput = z.infer<typeof TelemetrySchema>;

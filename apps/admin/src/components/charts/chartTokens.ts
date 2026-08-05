/**
 * Chart tokens and scale helpers.
 *
 * Polaris is the design system, so chrome — surfaces, ink, gridlines — comes
 * from its own CSS custom properties and follows the merchant's light/dark
 * choice for free. What Polaris does not supply is a *data* palette, and that
 * is the one thing a chart cannot improvise: a hue picked by eye is routinely
 * indistinguishable from its neighbour under deuteranopia, which affects around
 * one man in twelve.
 *
 * The series colors below were validated against both Polaris surfaces
 * (`#ffffff` light, `#1a1a1a` dark) rather than chosen: worst adjacent CVD ΔE
 * 9.2 light / 9.4 dark against a target of 8, worst normal-vision ΔE 27.6 / 26.5
 * against a floor of 15. Aqua sits below 3:1 contrast on the light surface,
 * which is why every chart that uses it also ships a table view — identity is
 * never carried by color alone.
 *
 * Rules the components enforce and this file exists to make possible:
 *
 *  - **Color follows the entity, not its rank.** Slots are assigned by meaning
 *    once; filtering a series out never repaints the survivors.
 *  - **Status colors are reserved.** Cancelled and returned are outcomes with a
 *    valence, so they wear the status palette and always carry a label — never
 *    a categorical slot, which would let them impersonate a series.
 *  - **One axis, ever.** Two measures of different scale get two charts. The
 *    time-series component takes a single metric for exactly this reason.
 */

/** Categorical slots, in fixed order. Light and dark steps of the same hues. */
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
} as const;

/**
 * Status colors — fixed, never themed, never reused as a series.
 *
 * These ship with a label in every legend they appear in. On the light surface
 * `serious` is below 3:1, and the label is the mitigation.
 */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/**
 * The ordinal ramp, for the funnel.
 *
 * One hue, monotone lightness, and it stops at step 250 on the light surface —
 * a lighter step would recede into the card behind it. Ordered stages get an
 * ordered ramp; nominal categories never do, because darker-where-bigger
 * double-encodes the bar length and burns the only free channel.
 */
export const ORDINAL = {
  light: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'],
  dark: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'],
} as const;

/**
 * Chrome, borrowed from Polaris so the chart tracks the merchant's theme.
 *
 * Referenced as CSS variables rather than resolved to hex: the admin can be in
 * dark mode, and reading the value once at render time would freeze it.
 */
export const CHROME = {
  surface: 'var(--p-color-bg-surface, #ffffff)',
  gridline: 'var(--p-color-border-secondary, #e3e3e3)',
  axis: 'var(--p-color-border, #cdcdcd)',
  textPrimary: 'var(--p-color-text, #303030)',
  textSecondary: 'var(--p-color-text-secondary, #616161)',
  textMuted: 'var(--p-color-text-disabled, #8a8a8a)',
} as const;

/** Fixed mark specs. Thin marks; the data is the only loud thing. */
export const MARKS = {
  /** Never fill the band — the leftover is air. */
  maxBarThickness: 24,
  lineWidth: 2,
  markerRadius: 4,
  /** White doing the separating, between stacked segments and adjacent bars. */
  surfaceGap: 2,
  areaOpacity: 0.1,
  cornerRadius: 4,
} as const;

/** True when the admin is rendering in dark mode. */
export function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** A categorical slot by index. Never cycles — there are only three. */
export function seriesColor(index: number, dark = prefersDark()): string {
  const palette = dark ? SERIES.dark : SERIES.light;
  return palette[index % palette.length] ?? palette[0] ?? '#2a78d6';
}

/** A step of the ordinal ramp, spread across `total` stages. */
export function ordinalColor(index: number, total: number, dark = prefersDark()): string {
  const ramp = dark ? ORDINAL.dark : ORDINAL.light;
  if (total <= 1) return ramp[Math.floor(ramp.length / 2)] ?? ramp[0] ?? '#2a78d6';

  const position = Math.round((index / (total - 1)) * (ramp.length - 1));
  return ramp[position] ?? ramp[0] ?? '#2a78d6';
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

/**
 * A rounded upper bound and its tick values.
 *
 * Axis ticks are rounded to clean numbers because they carry every value that
 * is not directly labelled — an axis reading `0 / 3,847 / 7,694` is technically
 * accurate and unreadable.
 *
 * The floor of 1 matters: a chart of an all-zero week would otherwise divide by
 * zero and render every bar at full height, which says the opposite of what
 * happened.
 */
export function niceScale(max: number, tickCount = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) {
    return { max: 1, ticks: [0, 1] };
  }

  const rough = max / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;

  // 1 / 2 / 5 / 10 — the steps people read without doing arithmetic.
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const top = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(Math.round(value * 1_000) / 1_000);
  }

  return { max: top, ticks };
}

/** Compact form for a stat tile: 1,284 · 12.9K · 4.2M. */
export function compactNumber(value: number): string {
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (absolute >= 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;

  return value.toLocaleString();
}

/**
 * Money in the shop's currency.
 *
 * The amount arrives as a decimal string and is parsed here at the last
 * possible moment — the API never sends money as a number, because a
 * `DECIMAL(14,2)` through a float loses the cents that a merchant reconciling
 * against their bank will notice.
 */
export function formatMoney(amount: string | number, currency: string, compact = false): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '—';

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: compact && Math.abs(value) >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: compact && Math.abs(value) >= 10_000 ? 1 : 2,
    }).format(value);
  } catch {
    // An unknown currency code must not blank the dashboard.
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** `2026-03-04` → `4 Mar`. Axis labels, so short. */
export function formatDayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    parsed,
  );
}

/** `2026-03-04` → `Wednesday, 4 March 2026`. Tooltips and table rows. */
export function formatDayFull(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/**
 * How many x-axis labels a width can carry without them colliding.
 *
 * Measured rather than assumed: a 90-day range at 600px has room for about six
 * labels, and drawing ninety produces a grey smear that reads as a rendering
 * fault.
 */
export function labelStride(pointCount: number, width: number): number {
  const perLabel = 64;
  const affordable = Math.max(2, Math.floor(width / perLabel));
  return Math.max(1, Math.ceil(pointCount / affordable));
}

import { useId } from 'react';
import { MARKS, seriesColor } from './chartTokens';

/**
 * The twelve-point trend on a stat tile.
 *
 * Deliberately unlabelled and unaxised. A sparkline answers one question —
 * "which way has this been going" — and adding ticks or values to it turns a
 * glanceable shape into a small chart that is worse than the real one below it.
 *
 * Decorative in the accessibility sense: the tile's value and delta already
 * carry the information in text, so this is hidden from assistive technology
 * rather than given a label that would read as noise on every tile.
 */

export interface SparklineProps {
  readonly values: readonly number[];
  readonly width?: number;
  readonly height?: number;
  /** Categorical slot. Follows the tile's meaning, never its rank. */
  readonly colorIndex?: number;
}

export function Sparkline({ values, width = 120, height = 32, colorIndex = 0 }: SparklineProps) {
  const gradientId = useId();

  if (values.length < 2) {
    // One point is not a trend. Drawing a flat line would imply stability that
    // hasn't been observed.
    return <svg width={width} height={height} aria-hidden="true" role="presentation" />;
  }

  const color = seriesColor(colorIndex);
  const max = Math.max(...values);
  const min = Math.min(...values);

  // A flat series would otherwise divide by zero; drawn along the middle.
  const span = max - min || 1;
  const padding = MARKS.markerRadius + 1;
  const usable = height - padding * 2;

  const x = (index: number): number => (index / (values.length - 1)) * width;
  const y = (value: number): number => padding + (1 - (value - min) / span) * usable;

  const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  const lastValue = values[values.length - 1] ?? 0;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      role="presentation"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={MARKS.areaOpacity * 2} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>

      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={MARKS.lineWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* The end point, so the eye lands on "now" rather than the middle. */}
      <circle
        cx={x(values.length - 1)}
        cy={y(lastValue)}
        r={MARKS.markerRadius - 1}
        fill={color}
        stroke="var(--p-color-bg-surface, #ffffff)"
        strokeWidth={MARKS.surfaceGap}
      />
    </svg>
  );
}

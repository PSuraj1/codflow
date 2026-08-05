import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Box, Text } from '@shopify/polaris';
import {
  CHROME,
  MARKS,
  formatDayFull,
  formatDayLabel,
  labelStride,
  niceScale,
  seriesColor,
} from './chartTokens';

/**
 * A single metric over time.
 *
 * **One series, one axis.** The component takes one value per day and offers no
 * way to plot a second, which is the point: two measures of different scale on
 * one plot invent a correlation that is not in the data — a chart with orders
 * on the left and revenue on the right will show them tracking each other
 * whatever the underlying numbers do, because the two scales were aligned
 * arbitrarily. Two measures get two charts, or a selector that swaps between
 * them on one axis.
 *
 * A single series also means no legend: the card's title already names what is
 * plotted, and a box with one swatch in it only restates the title.
 *
 * The hover layer is not optional. An SVG chart in a browser *is* interactive,
 * and the crosshair is what carries the per-day values that would be chaos as
 * printed labels — the alternative is a number beside every point, which goes
 * unread. Keyboard users get the same values from the frame's table view.
 */

export interface TimeSeriesPoint {
  readonly date: string;
  readonly value: number;
}

export interface TimeSeriesChartProps {
  readonly points: readonly TimeSeriesPoint[];
  /** Names the metric in the tooltip. The card title carries it visually. */
  readonly metricLabel: string;
  /** Renders a value for the tooltip and the axis — money, counts, percentages. */
  readonly formatValue: (value: number) => string;
  readonly colorIndex?: number;
  readonly height?: number;
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 56 } as const;
const VIEWPORT_WIDTH = 720;

export function TimeSeriesChart({
  points,
  metricLabel,
  formatValue,
  colorIndex = 0,
  height = 240,
}: TimeSeriesChartProps) {
  const gradientId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const color = seriesColor(colorIndex);

  const geometry = useMemo(() => {
    const width = VIEWPORT_WIDTH;
    const plotWidth = width - PADDING.left - PADDING.right;
    const plotHeight = height - PADDING.top - PADDING.bottom;

    const max = Math.max(...points.map((point) => point.value), 0);
    const scale = niceScale(max);

    const x = (index: number): number =>
      points.length <= 1
        ? PADDING.left + plotWidth / 2
        : PADDING.left + (index / (points.length - 1)) * plotWidth;

    const y = (value: number): number =>
      PADDING.top + plotHeight - (value / scale.max) * plotHeight;

    return { width, plotWidth, plotHeight, scale, x, y };
  }, [points, height]);

  /**
   * Maps a pointer position to the nearest day.
   *
   * Nearest-point rather than per-mark hit testing: a 2px line and an 8px dot
   * are far smaller than a comfortable hit target, and requiring the merchant
   * to land on one makes the chart feel broken. The whole column is the target.
   */
  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || points.length === 0) return;

      const bounds = svg.getBoundingClientRect();
      const relative = ((event.clientX - bounds.left) / bounds.width) * geometry.width;
      const ratio = (relative - PADDING.left) / geometry.plotWidth;
      const index = Math.round(ratio * Math.max(points.length - 1, 1));

      setHovered(Math.min(Math.max(index, 0), points.length - 1));
    },
    [geometry, points.length],
  );

  if (points.length === 0) return null;

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${geometry.x(index)},${geometry.y(point.value)}`)
    .join(' ');

  const baseline = PADDING.top + geometry.plotHeight;
  const areaPath = `${linePath} L${geometry.x(points.length - 1)},${baseline} L${geometry.x(0)},${baseline} Z`;

  const stride = labelStride(points.length, geometry.plotWidth);
  const active = hovered === null ? null : points[hovered];
  const lastPoint = points[points.length - 1];

  return (
    <Box position="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${geometry.width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${metricLabel} by day. Use the table view for exact values.`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHovered(null)}
        style={{ display: 'block', touchAction: 'pan-y' }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={MARKS.areaOpacity * 2} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Gridlines: solid hairlines one step off the surface. Dashing would
            read as "projection" or "threshold" when it is just a grid. */}
        {geometry.scale.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PADDING.left}
              x2={geometry.width - PADDING.right}
              y1={geometry.y(tick)}
              y2={geometry.y(tick)}
              stroke={CHROME.gridline}
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={geometry.y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fill={CHROME.textMuted}
              fontSize={11}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={MARKS.lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* x-axis labels, thinned to what the width can carry without collision. */}
        {points.map((point, index) =>
          index % stride === 0 || index === points.length - 1 ? (
            <text
              key={point.date}
              x={geometry.x(index)}
              y={height - 8}
              textAnchor={index === points.length - 1 ? 'end' : 'middle'}
              fill={CHROME.textMuted}
              fontSize={11}
            >
              {formatDayLabel(point.date)}
            </text>
          ) : null,
        )}

        {/* The endpoint is the one point worth marking without being asked —
            it is where the merchant's eye goes for "where are we now". */}
        {lastPoint ? (
          <circle
            cx={geometry.x(points.length - 1)}
            cy={geometry.y(lastPoint.value)}
            r={MARKS.markerRadius}
            fill={color}
            stroke={CHROME.surface}
            strokeWidth={MARKS.surfaceGap}
          />
        ) : null}

        {hovered !== null && active ? (
          <g pointerEvents="none">
            <line
              x1={geometry.x(hovered)}
              x2={geometry.x(hovered)}
              y1={PADDING.top}
              y2={baseline}
              stroke={CHROME.axis}
              strokeWidth={1}
            />
            <circle
              cx={geometry.x(hovered)}
              cy={geometry.y(active.value)}
              r={MARKS.markerRadius}
              fill={color}
              stroke={CHROME.surface}
              strokeWidth={MARKS.surfaceGap}
            />
          </g>
        ) : null}
      </svg>

      {active ? (
        <Box
          position="absolute"
          insetBlockStart="0"
          insetInlineStart="0"
          background="bg-surface"
          borderRadius="200"
          borderWidth="025"
          borderColor="border"
          padding="200"
          /*
            Anchored to the hovered column and clamped so it never leaves the
            card. Following the pointer exactly would let it fall off the right
            edge on the last few days of a range.
          */
          insetInlineEnd={hovered !== null && hovered > points.length / 2 ? '0' : undefined}
          zIndex="1"
        >
          <Text as="p" variant="bodySm" tone="subdued">
            {formatDayFull(active.date)}
          </Text>
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {`${formatValue(active.value)} ${metricLabel.toLowerCase()}`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

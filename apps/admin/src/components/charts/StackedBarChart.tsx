import { useState } from 'react';
import { BlockStack, Box, InlineStack, Text } from '@shopify/polaris';
import { CHROME, MARKS, STATUS, formatDayFull, formatDayLabel, labelStride, niceScale } from './chartTokens';

/**
 * Daily order outcomes: delivered, cancelled, returned.
 *
 * These wear the **status** palette rather than categorical slots, because the
 * colors mean something here — good, serious, critical — and a merchant reads
 * them that way whether or not the chart intends it. Status colors are reserved
 * for exactly this, and never reused as "series four".
 *
 * Which is also why the legend is mandatory and labelled. On Polaris's light
 * surface `serious` sits below 3:1 contrast, and two of these three are close
 * enough in hue under deuteranopia that color alone would not separate them.
 * The label is the mechanism that makes them distinguishable; the color is the
 * shorthand for readers who can use it.
 *
 * Segments are separated by a 2px gap in the surface color rather than a stroke
 * around each one. A border adds ink that is not data, and at these bar widths
 * it visibly thickens the smaller segments.
 */

export interface StackedPoint {
  readonly date: string;
  readonly fulfilled: number;
  readonly cancelled: number;
  readonly returned: number;
}

export interface StackedBarChartProps {
  readonly points: readonly StackedPoint[];
  readonly height?: number;
}

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 } as const;
const VIEWPORT_WIDTH = 720;

const SEGMENTS = [
  { key: 'fulfilled' as const, label: 'Delivered', color: STATUS.good },
  { key: 'cancelled' as const, label: 'Cancelled', color: STATUS.critical },
  { key: 'returned' as const, label: 'Returned', color: STATUS.serious },
];

export function StackedBarChart({ points, height = 220 }: StackedBarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (points.length === 0) return null;

  const plotWidth = VIEWPORT_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;

  const totals = points.map((point) => point.fulfilled + point.cancelled + point.returned);
  const scale = niceScale(Math.max(...totals, 0));

  const band = plotWidth / points.length;
  // Capped rather than filling the band — the leftover is deliberate air, and
  // it is what keeps adjacent days visually separate without a second spacer.
  const barWidth = Math.min(MARKS.maxBarThickness, band * 0.6);

  const y = (value: number): number => PADDING.top + plotHeight - (value / scale.max) * plotHeight;
  const stride = labelStride(points.length, plotWidth);
  const active = hovered === null ? null : points[hovered];

  return (
    <BlockStack gap="300">
      <Box position="relative">
        <svg
          viewBox={`0 0 ${VIEWPORT_WIDTH} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label="Order outcomes by day: delivered, cancelled and returned. Use the table view for exact values."
          style={{ display: 'block' }}
          onPointerLeave={() => setHovered(null)}
        >
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={VIEWPORT_WIDTH - PADDING.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke={CHROME.gridline}
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 8}
                y={y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fill={CHROME.textMuted}
                fontSize={11}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {tick.toLocaleString()}
              </text>
            </g>
          ))}

          {points.map((point, index) => {
            const centre = PADDING.left + band * index + band / 2;
            const left = centre - barWidth / 2;
            let cursor = PADDING.top + plotHeight;

            return (
              <g
                key={point.date}
                onPointerEnter={() => setHovered(index)}
                // The hit target is the whole band, not the bar: a one-order day
                // is three pixels tall and impossible to hover otherwise.
                pointerEvents="all"
              >
                <rect
                  x={PADDING.left + band * index}
                  y={PADDING.top}
                  width={band}
                  height={plotHeight}
                  fill="transparent"
                />

                {SEGMENTS.map((segment) => {
                  const value = point[segment.key];
                  if (value <= 0) return null;

                  const segmentHeight = (value / scale.max) * plotHeight;
                  const top = cursor - segmentHeight;
                  cursor = top - MARKS.surfaceGap;

                  return (
                    <rect
                      key={segment.key}
                      x={left}
                      y={top}
                      width={barWidth}
                      height={Math.max(segmentHeight - MARKS.surfaceGap, 1)}
                      fill={segment.color}
                      opacity={hovered === null || hovered === index ? 1 : 0.4}
                    />
                  );
                })}
              </g>
            );
          })}

          {points.map((point, index) =>
            index % stride === 0 || index === points.length - 1 ? (
              <text
                key={point.date}
                x={PADDING.left + band * index + band / 2}
                y={height - 8}
                textAnchor="middle"
                fill={CHROME.textMuted}
                fontSize={11}
              >
                {formatDayLabel(point.date)}
              </text>
            ) : null,
          )}
        </svg>

        {active ? (
          <Box
            position="absolute"
            insetBlockStart="0"
            insetInlineStart={hovered !== null && hovered > points.length / 2 ? undefined : '0'}
            insetInlineEnd={hovered !== null && hovered > points.length / 2 ? '0' : undefined}
            background="bg-surface"
            borderRadius="200"
            borderWidth="025"
            borderColor="border"
            padding="200"
            zIndex="1"
          >
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                {formatDayFull(active.date)}
              </Text>
              {SEGMENTS.map((segment) => (
                <InlineStack key={segment.key} gap="200" blockAlign="center" wrap={false}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: segment.color,
                      display: 'inline-block',
                    }}
                  />
                  <Text as="span" variant="bodySm">
                    {`${segment.label}: ${active[segment.key].toLocaleString()}`}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Box>
        ) : null}
      </Box>

      {/* Always present, never optional: identity must not rest on color. */}
      <InlineStack gap="400" wrap>
        {SEGMENTS.map((segment) => (
          <InlineStack key={segment.key} gap="150" blockAlign="center" wrap={false}>
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: segment.color,
                display: 'inline-block',
              }}
            />
            <Text as="span" variant="bodySm" tone="subdued">
              {segment.label}
            </Text>
          </InlineStack>
        ))}
      </InlineStack>
    </BlockStack>
  );
}

import { BlockStack, Box, InlineStack, Text } from '@shopify/polaris';
import { MARKS, seriesColor } from './chartTokens';

/**
 * A ranking — top countries, cities, products.
 *
 * Horizontal rather than vertical because the labels are names: "United Arab
 * Emirates" as a rotated column label is unreadable, and truncating it to fit
 * defeats the purpose of a ranking nobody can identify.
 *
 * **One series, one color.** Every bar wears slot 1. Shading each bar darker
 * where it is longer is a common instinct and wrong twice over: it double-
 * encodes the length the bar already shows, and it spends the one free channel
 * on information the reader has. A value ramp belongs on ordered categories, not
 * on a list of countries.
 *
 * Values are labelled at the tip of each bar rather than on an axis. With eight
 * rows that is eight labels — sparing enough to stay readable, and it removes
 * the need for gridlines entirely.
 */

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** Secondary figure shown after the value — revenue beside an order count. */
  readonly secondary?: string;
}

export interface HorizontalBarChartProps {
  readonly data: readonly BarDatum[];
  readonly formatValue: (value: number) => string;
  readonly colorIndex?: number;
}

export function HorizontalBarChart({ data, formatValue, colorIndex = 0 }: HorizontalBarChartProps) {
  if (data.length === 0) return null;

  const color = seriesColor(colorIndex);
  const max = Math.max(...data.map((datum) => datum.value), 1);

  return (
    <BlockStack gap="300">
      {data.map((datum) => {
        const share = Math.max((datum.value / max) * 100, datum.value > 0 ? 1.5 : 0);

        return (
          <BlockStack gap="100" key={datum.key}>
            <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
              <Text as="span" variant="bodySm" truncate>
                {datum.label}
              </Text>

              <InlineStack gap="200" blockAlign="center" wrap={false}>
                {/*
                  Text wears text tokens, never the series color. Identity comes
                  from the colored bar beside it — a light hue is illegible as
                  text on the surface.
                */}
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {formatValue(datum.value)}
                </Text>
                {datum.secondary ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {datum.secondary}
                  </Text>
                ) : null}
              </InlineStack>
            </InlineStack>

            {/*
              The track is the recessive surface, the fill is the data. Capped
              thickness with the leftover left as air rather than filling the
              band — a fat bar reads loud without saying more.
            */}
            <Box background="bg-surface-secondary" borderRadius="100" minHeight="8px">
              <div
                style={{
                  width: `${share}%`,
                  height: `${MARKS.maxBarThickness / 3}px`,
                  background: color,
                  // Rounded at the data end, square at the baseline — the bar
                  // grows from the axis and should look anchored to it.
                  borderRadius: `0 ${MARKS.cornerRadius}px ${MARKS.cornerRadius}px 0`,
                }}
              />
            </Box>
          </BlockStack>
        );
      })}
    </BlockStack>
  );
}

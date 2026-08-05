import { BlockStack, Box, Card, Icon, InlineStack, Text, Tooltip } from '@shopify/polaris';
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from '@shopify/polaris-icons';
import type { TrendDirection } from '@codflow/shared';
import { Sparkline } from './Sparkline';

/**
 * One headline number.
 *
 * The form to reach for when the story is a single figure — which is most of a
 * dashboard's top row. Eight categorical hues and a plot area would be the
 * commonest way to miss the point of these.
 *
 * The delta is the part that needs care. Direction and *goodness* are separate:
 * orders rising is good, cancellations rising is not, and a tile that colors
 * every increase green tells a merchant their return rate is improving while it
 * doubles. `invertDirection` is how a tile says which way is up for it. The
 * arrow icon carries the same information as the color, so the meaning survives
 * for a colorblind reader and in a printout.
 */

export interface StatTileProps {
  readonly label: string;
  readonly value: string;
  /** Signed percentage against the comparison period. Null when there is no base. */
  readonly changePct?: number | null;
  readonly direction?: TrendDirection;
  /** Names the comparison, e.g. "vs previous 30 days". */
  readonly comparisonLabel?: string;
  /** True when a *fall* is the good outcome — cancellations, returns, risk. */
  readonly invertDirection?: boolean;
  readonly trend?: readonly number[];
  readonly colorIndex?: number;
  /** Shown on hover when the number needs a definition. */
  readonly help?: string;
}

function toneFor(
  direction: TrendDirection | undefined,
  invert: boolean,
): 'success' | 'critical' | 'subdued' {
  if (!direction || direction === 'flat') return 'subdued';

  const rising = direction === 'up';
  const good = invert ? !rising : rising;

  return good ? 'success' : 'critical';
}

export function StatTile({
  label,
  value,
  changePct,
  direction,
  comparisonLabel = 'vs previous period',
  invertDirection = false,
  trend,
  colorIndex = 0,
  help,
}: StatTileProps) {
  const tone = toneFor(direction, invertDirection);
  const icon = direction === 'up' ? ArrowUpIcon : direction === 'down' ? ArrowDownIcon : MinusIcon;

  const heading = (
    <Text as="h3" variant="bodySm" tone="subdued">
      {label}
    </Text>
  );

  return (
    <Card>
      <BlockStack gap="200">
        {help ? <Tooltip content={help}>{heading}</Tooltip> : heading}

        <InlineStack align="space-between" blockAlign="end" gap="200" wrap={false}>
          {/*
            Proportional figures, not tabular: `tabular-nums` gives every digit
            the width of a zero, which makes a large standalone number look
            loose. Tabular is for columns that must align.
          */}
          <Text as="p" variant="heading2xl" fontWeight="semibold">
            {value}
          </Text>

          {trend && trend.length > 1 ? (
            <Box>
              <Sparkline values={trend} colorIndex={colorIndex} />
            </Box>
          ) : null}
        </InlineStack>

        {changePct === null || changePct === undefined ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {/*
              No base to compare against. Saying "up 100%" from zero would be
              true of every first order and informative about nothing.
            */}
            No comparison available
          </Text>
        ) : (
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            <Box>
              <Icon source={icon} tone={tone === 'subdued' ? 'subdued' : tone} />
            </Box>
            <Text as="p" variant="bodySm" tone={tone}>
              {`${changePct > 0 ? '+' : ''}${changePct}%`}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {comparisonLabel}
            </Text>
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

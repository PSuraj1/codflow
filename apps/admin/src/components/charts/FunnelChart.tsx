import { BlockStack, Box, InlineStack, Text } from '@shopify/polaris';
import type { FunnelStage } from '@codflow/shared';
import { MARKS, ordinalColor } from './chartTokens';

/**
 * The COD funnel.
 *
 * The one place in this dashboard where a value ramp is correct: the stages are
 * *ordered*, and the ramp's darkening carries that order rather than restating
 * a magnitude. It is a single hue with monotone lightness — a rainbow here
 * would imply the stages are different kinds of thing rather than steps of one
 * sequence.
 *
 * Each row shows the drop from the stage above it, because that is the number a
 * merchant can act on. A funnel losing 80% between "opened the form" and
 * "submitted" has a form problem; one losing 80% between "submitted" and
 * "created in Shopify" has a fraud rule or a push failure. A single overall
 * conversion figure cannot tell those apart, and they need opposite fixes.
 */

export interface FunnelChartProps {
  readonly stages: readonly FunnelStage[];
}

export function FunnelChart({ stages }: FunnelChartProps) {
  if (stages.length === 0) return null;

  const first = stages[0]?.count ?? 0;

  return (
    <BlockStack gap="400">
      {stages.map((stage, index) => {
        const width = first > 0 ? Math.max((stage.count / first) * 100, stage.count > 0 ? 2 : 0) : 0;
        const color = ordinalColor(index, stages.length);

        // The drop into this stage — the actionable number, so it is the one
        // shown rather than the share of the top of the funnel.
        const drop =
          stage.conversionFromPrevious === null ? null : Math.round((100 - stage.conversionFromPrevious) * 10) / 10;

        return (
          <BlockStack gap="150" key={stage.key}>
            <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
              <Text as="span" variant="bodyMd">
                {stage.label}
              </Text>

              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {stage.count.toLocaleString()}
                </Text>
                {stage.conversionFromPrevious !== null ? (
                  <Text as="span" variant="bodySm" tone={drop !== null && drop > 50 ? 'critical' : 'subdued'}>
                    {`${stage.conversionFromPrevious}% of previous`}
                  </Text>
                ) : null}
              </InlineStack>
            </InlineStack>

            <Box background="bg-surface-secondary" borderRadius="100" minHeight="12px">
              <div
                style={{
                  width: `${width}%`,
                  height: `${MARKS.maxBarThickness / 2}px`,
                  background: color,
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

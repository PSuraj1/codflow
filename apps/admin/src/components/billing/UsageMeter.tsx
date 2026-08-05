import { BlockStack, Box, Icon, InlineStack, Text } from '@shopify/polaris';
import { AlertTriangleIcon, CheckCircleIcon } from '@shopify/polaris-icons';
import type { UsageSummary } from '@codflow/shared';
import { STATUS } from '../charts/chartTokens';

/**
 * One metered resource against its cap.
 *
 * A meter, not a chart: the fill carries severity and the unfilled track is a
 * lighter step of the same ramp, so the state reads across the whole bar rather
 * than only where the fill ends.
 *
 * Severity is never carried by colour alone. Each state ships an icon and a
 * sentence, because the merchant this component matters most to — the one at
 * 100% wondering why orders stopped — must not have to distinguish amber from
 * red to find out.
 */

export interface UsageMeterProps {
  readonly usage: UsageSummary;
}

function toneFor(usage: UsageSummary): { color: string; track: string; message: string } {
  if (usage.limit === null) {
    return {
      color: STATUS.good,
      track: 'rgba(12, 163, 12, 0.15)',
      message: 'Unlimited on your plan',
    };
  }

  if (usage.exceeded) {
    return {
      color: STATUS.critical,
      track: 'rgba(208, 59, 59, 0.15)',
      message: 'Limit reached — new ones are being refused until you upgrade or the month resets',
    };
  }

  if (usage.nearLimit) {
    return {
      color: STATUS.warning,
      track: 'rgba(250, 178, 25, 0.18)',
      message: `${(usage.limit - usage.used).toLocaleString()} left this month`,
    };
  }

  return {
    color: STATUS.good,
    track: 'rgba(12, 163, 12, 0.15)',
    message: `${(usage.limit - usage.used).toLocaleString()} left this month`,
  };
}

export function UsageMeter({ usage }: UsageMeterProps) {
  const tone = toneFor(usage);
  const percent = usage.percentUsed ?? 0;

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
        <Text as="h3" variant="bodyMd" fontWeight="medium">
          {usage.label}
        </Text>

        <Text as="span" variant="bodyMd" fontWeight="semibold">
          {usage.limit === null
            ? usage.used.toLocaleString()
            : `${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()}`}
        </Text>
      </InlineStack>

      <Box borderRadius="100" minHeight="8px" background="bg-surface-secondary">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${usage.label}: ${percent}% of your monthly limit used`}
          style={{
            width: `${usage.limit === null ? 0 : Math.max(percent, usage.used > 0 ? 2 : 0)}%`,
            height: '8px',
            background: tone.color,
            borderRadius: '4px',
          }}
        />
      </Box>

      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <Box>
          <Icon
            source={usage.exceeded || usage.nearLimit ? AlertTriangleIcon : CheckCircleIcon}
            tone={usage.exceeded ? 'critical' : usage.nearLimit ? 'caution' : 'success'}
          />
        </Box>
        <Text
          as="p"
          variant="bodySm"
          tone={usage.exceeded ? 'critical' : usage.nearLimit ? 'caution' : 'subdued'}
        >
          {tone.message}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}

import { Badge, BlockStack, Box, InlineStack, Text } from '@shopify/polaris';
import type { RiskSignalResult } from '@codflow/shared';

/**
 * Risk presentation.
 *
 * A merchant deciding whether to ship a parcel needs the *reasons*, not the
 * number. A score of 62 tells them nothing actionable; "3 orders from this
 * phone in the last hour" and "throwaway email address" tell them what to ask
 * about when they call.
 */

const TONE: Record<string, 'success' | 'attention' | 'warning' | 'critical'> = {
  LOW: 'success',
  MEDIUM: 'attention',
  HIGH: 'warning',
  CRITICAL: 'critical',
};

const ACTION_LABEL: Record<string, string> = {
  ALLOW: 'Allowed',
  REVIEW: 'Held for review',
  CHALLENGE_OTP: 'Awaiting phone verification',
  BLOCK: 'Blocked',
};

export function RiskBadge({ level, score }: { level: string; score: number }) {
  return (
    <Badge tone={TONE[level] ?? 'attention'}>{`${level} · ${score}`}</Badge>
  );
}

export function RiskActionBadge({ action }: { action: string }) {
  return (
    <Badge tone={action === 'ALLOW' ? 'success' : action === 'BLOCK' ? 'critical' : 'attention'}>
      {ACTION_LABEL[action] ?? action}
    </Badge>
  );
}

/**
 * The signal breakdown.
 *
 * Zero-weight signals are filtered out — they are diagnostic noise for a
 * merchant, who only cares about what moved the number. A negative weight is
 * shown in green because it represents trust (a whitelist entry), and hiding it
 * would make an allowed-but-risky-looking order inexplicable.
 */
export function RiskSignalList({ signals }: { signals: readonly RiskSignalResult[] }) {
  const meaningful = signals.filter((entry) => entry.weight !== 0);

  if (meaningful.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Nothing unusual was detected on this order.
      </Text>
    );
  }

  return (
    <BlockStack gap="200">
      {meaningful
        .slice()
        // Heaviest first: the reason a merchant is looking at this order is
        // almost always the top line.
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
        .map((entry, index) => (
          <Box
            key={`${entry.code}-${index}`}
            padding="300"
            background={entry.weight < 0 ? 'bg-surface-success' : 'bg-surface-secondary'}
            borderRadius="200"
          >
            <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
              <BlockStack gap="050">
                <Text as="span" variant="bodyMd">
                  {entry.label}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {entry.code}
                </Text>
              </BlockStack>

              <Badge tone={entry.weight < 0 ? 'success' : entry.weight >= 40 ? 'critical' : 'attention'}>
                {entry.weight > 0 ? `+${entry.weight}` : String(entry.weight)}
              </Badge>
            </InlineStack>
          </Box>
        ))}
    </BlockStack>
  );
}

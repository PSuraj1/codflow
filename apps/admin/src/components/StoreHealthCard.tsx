import { useNavigate } from 'react-router-dom';
import { Badge, BlockStack, Button, Card, InlineStack, SkeletonBodyText, Text } from '@shopify/polaris';
import type { HealthCheck, HealthState } from '@codflow/shared';
import { useStoreHealth } from '../hooks/useAnalytics';

/**
 * Store health.
 *
 * Every check here reports a failure the merchant would otherwise never see. A
 * Google refresh token revoked three weeks ago, a pixel that has never
 * delivered an event, orders sitting behind a failed push — the app keeps
 * looking fine from the outside while each one costs money.
 *
 * State is carried by an icon-equivalent (the badge's own tone *and* its text)
 * plus a written summary, never by color alone. The badge tone is the
 * shorthand; the sentence underneath is the actual message.
 */

const TONE: Record<HealthState, 'success' | 'attention' | 'critical' | 'info'> = {
  ok: 'success',
  warning: 'attention',
  critical: 'critical',
  not_configured: 'info',
};

const BADGE_TEXT: Record<HealthState, string> = {
  ok: 'Working',
  warning: 'Needs attention',
  critical: 'Action needed',
  not_configured: 'Not set up',
};

function CheckRow({ check }: { check: HealthCheck }) {
  const navigate = useNavigate();

  return (
    <BlockStack gap="150">
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
        <Text as="h4" variant="bodyMd" fontWeight="medium">
          {check.label}
        </Text>
        <Badge tone={TONE[check.state]}>{BADGE_TEXT[check.state]}</Badge>
      </InlineStack>

      <Text as="p" variant="bodySm" tone="subdued">
        {check.summary}
      </Text>

      {check.actionPath && check.state !== 'ok' ? (
        <InlineStack>
          <Button variant="plain" onClick={() => navigate(check.actionPath as string)}>
            {check.state === 'not_configured' ? 'Set it up' : 'Fix it'}
          </Button>
        </InlineStack>
      ) : null}
    </BlockStack>
  );
}

export function StoreHealthCard() {
  const { data, isPending, error } = useStoreHealth();

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
          <Text as="h2" variant="headingMd">
            Store health
          </Text>
          {data ? <Badge tone={TONE[data.overall]}>{BADGE_TEXT[data.overall]}</Badge> : null}
        </InlineStack>

        {isPending ? (
          <SkeletonBodyText lines={6} />
        ) : error ? (
          <Text as="p" variant="bodySm" tone="critical">
            {error.message}
          </Text>
        ) : (
          <BlockStack gap="400">
            {data?.checks.map((check) => <CheckRow key={check.key} check={check} />)}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

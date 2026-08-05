import { useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Select,
  Text,
} from '@shopify/polaris';
import { SERVER_SIDE_EVENTS, type PixelEventName, type PixelSummary } from '@codflow/shared';
import { useDeletePixel, useTestPixel, useUpdatePixel } from '../../hooks/usePixels';
import { EVENT_LABELS, PROVIDER_CATALOGUE } from './providerCatalogue';

/**
 * One configured pixel.
 *
 * The counters and the last error are given as much room as the configuration,
 * because "is this actually working" is the question a merchant opens this
 * screen with. A pixel that is switched on and has sent nothing looks identical
 * to a working one until you show the numbers.
 *
 * Testing is only offered where it means something: the tester sends a real
 * server-to-server event, so it needs server-side tracking switched on. Offering
 * it otherwise would report a failure that says nothing about whether the
 * merchant's browser tracking works.
 */

interface Props {
  pixel: PixelSummary;
  onEdit: () => void;
}

export function PixelCard({ pixel, onEdit }: Props) {
  const update = useUpdatePixel();
  const remove = useDeletePixel();
  const test = useTestPixel();

  const [testEvent, setTestEvent] = useState<PixelEventName>('PURCHASE');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const copy = PROVIDER_CATALOGUE[pixel.provider];
  const result = test.data;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" wrap={false}>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingMd">
                {pixel.label}
              </Text>
              {pixel.isEnabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
            </InlineStack>

            <Text as="p" variant="bodySm" tone="subdued">
              {copy.name} · {pixel.pixelId}
            </Text>

            <InlineStack gap="200">
              {pixel.clientSideEnabled ? <Badge tone="info">Browser</Badge> : null}
              {pixel.serverSideEnabled ? <Badge tone="info">Server</Badge> : null}
              {pixel.serverSideEnabled && copy.needsAccessToken && !pixel.hasAccessToken ? (
                <Badge tone="critical">No token</Badge>
              ) : null}
              {pixel.testEventCode ? <Badge tone="attention">Test mode</Badge> : null}
            </InlineStack>
          </BlockStack>

          <InlineStack gap="200">
            <Button
              variant="tertiary"
              loading={update.isPending}
              onClick={() => update.mutate({ id: pixel.id, isEnabled: !pixel.isEnabled })}
            >
              {pixel.isEnabled ? 'Turn off' : 'Turn on'}
            </Button>
            <Button variant="tertiary" onClick={onEdit}>
              Edit
            </Button>
          </InlineStack>
        </InlineStack>

        {/*
          A test event code is easy to set and easy to forget, and while it is
          set nothing reaches live reporting — the merchant sees events in the
          platform's test view and concludes everything works.
        */}
        {pixel.testEventCode ? (
          <Banner tone="warning">
            <p>
              Events are going to {copy.name}&rsquo;s test view, not live reporting. Clear the test
              event code when you are ready to go live.
            </p>
          </Banner>
        ) : null}

        {pixel.lastError ? (
          <Banner tone="critical" title="The last event was refused">
            <p>{pixel.lastError}</p>
          </Banner>
        ) : null}

        <Box background="bg-surface-secondary" padding="300" borderRadius="200">
          <InlineStack gap="600" wrap>
            <BlockStack gap="050">
              <Text as="span" variant="bodySm" tone="subdued">
                Sent
              </Text>
              <Text as="span" variant="headingSm">
                {pixel.totalSent.toLocaleString()}
              </Text>
            </BlockStack>

            <BlockStack gap="050">
              <Text as="span" variant="bodySm" tone="subdued">
                Failed
              </Text>
              <Text as="span" variant="headingSm" tone={pixel.totalFailed > 0 ? 'critical' : undefined}>
                {pixel.totalFailed.toLocaleString()}
              </Text>
            </BlockStack>

            <BlockStack gap="050">
              <Text as="span" variant="bodySm" tone="subdued">
                Last event
              </Text>
              <Text as="span" variant="headingSm">
                {pixel.lastEventAt ? new Date(pixel.lastEventAt).toLocaleString() : 'Never'}
              </Text>
            </BlockStack>
          </InlineStack>
        </Box>

        {pixel.serverSideEnabled ? (
          <BlockStack gap="200">
            <Text as="h4" variant="headingSm">
              Send a test event
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Uses obviously fake customer details, so nothing real is written into your ad account.
            </Text>

            <InlineStack gap="200" blockAlign="end">
              <Box minWidth="220px">
                <Select
                  label="Event"
                  labelHidden
                  options={SERVER_SIDE_EVENTS.map((event) => ({
                    label: EVENT_LABELS[event],
                    value: event,
                  }))}
                  value={testEvent}
                  onChange={(value) => setTestEvent(value as PixelEventName)}
                />
              </Box>
              <Button
                loading={test.isPending}
                onClick={() => test.mutate({ id: pixel.id, eventName: testEvent })}
              >
                Send test
              </Button>
            </InlineStack>

            {result ? (
              <Banner tone={result.ok ? 'success' : 'critical'}>
                <BlockStack gap="100">
                  {/* The provider's own words. Paraphrasing loses the detail. */}
                  <p>{result.message}</p>
                  {result.matchQuality !== null ? (
                    <p>Match quality: {result.matchQuality}/10</p>
                  ) : null}
                </BlockStack>
              </Banner>
            ) : null}
          </BlockStack>
        ) : null}

        <InlineStack align="end">
          {confirmingDelete ? (
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodySm">
                Remove this pixel? Events already sent are unaffected.
              </Text>
              <Button variant="tertiary" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                tone="critical"
                loading={remove.isPending}
                onClick={() => remove.mutate(pixel.id)}
              >
                Remove
              </Button>
            </InlineStack>
          ) : (
            <Button variant="tertiary" tone="critical" onClick={() => setConfirmingDelete(true)}>
              Remove
            </Button>
          )}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

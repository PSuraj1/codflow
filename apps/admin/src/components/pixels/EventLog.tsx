import { Badge, BlockStack, Card, DataTable, Text } from '@shopify/polaris';
import type { PixelEventSummary } from '@codflow/shared';
import { usePixelEvents } from '../../hooks/usePixels';
import { EVENT_LABELS, PROVIDER_CATALOGUE } from './providerCatalogue';

/**
 * Recent dispatches.
 *
 * The screen's evidence. Everything above it describes what *should* happen;
 * this is the only place that shows what did — including the failures, which is
 * the point. A pixel reporting "on" while every dispatch is rejected is the
 * failure mode merchants discover from their ad reporting weeks later, and one
 * table of red rows here is worth any amount of configuration UI.
 *
 * The source column matters as much as the status: seeing a browser event and a
 * server event for the same order is what tells a merchant deduplication is
 * doing its job, rather than that they are being billed twice over.
 */

function statusBadge(status: string) {
  const normalized = status.toUpperCase();

  if (normalized === 'SENT') return <Badge tone="success">Sent</Badge>;
  if (normalized === 'FAILED') return <Badge tone="critical">Failed</Badge>;
  if (normalized === 'PENDING') return <Badge tone="attention">Pending</Badge>;
  return <Badge>{status}</Badge>;
}

function describe(event: PixelEventSummary): string {
  if (event.eventName === 'CUSTOM' && event.customEventName) return event.customEventName;
  return EVENT_LABELS[event.eventName] ?? event.eventName;
}

export function EventLog() {
  const { data: events, isPending, error } = usePixelEvents();

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Recent activity
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            The last events CodFlow sent, from both the browser and the server. Refreshes on its
            own while this page is open.
          </Text>
        </BlockStack>

        {error ? (
          <Text as="p" variant="bodySm" tone="critical">
            {error.message}
          </Text>
        ) : null}

        {!isPending && events && events.length === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Nothing yet. Events appear here as shoppers browse and orders come in — or as soon as
            you send a test.
          </Text>
        ) : null}

        {events && events.length > 0 ? (
          <DataTable
            columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text']}
            headings={['When', 'Event', 'Platform', 'From', 'Status', 'Detail']}
            rows={events.map((event) => [
              new Date(event.createdAt).toLocaleString(),
              describe(event),
              event.provider ? PROVIDER_CATALOGUE[event.provider].name : '—',
              event.source === 'server' ? 'Server' : 'Browser',
              statusBadge(event.status),
              // The provider's rejection reason, which is the whole value of
              // the row when something is wrong.
              event.errorMessage ??
                (event.value ? `${event.value} ${event.currency ?? ''}`.trim() : '—'),
            ])}
          />
        ) : null}
      </BlockStack>
    </Card>
  );
}

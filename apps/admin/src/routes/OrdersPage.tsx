import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Box,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Tabs,
  Text,
} from '@shopify/polaris';
import { StuckOrderGroup, type StuckOrderCounts } from '@codflow/shared';
import { useStuckOrders } from '../hooks/useOrders';
import { StuckOrderRow } from '../components/orders/StuckOrderRow';
import { SectionTabs, ANALYTICS_TABS } from '../components/SectionTabs';

/**
 * Orders that have not reached Shopify.
 *
 * Not a general order browser. Orders that reached Shopify are Shopify's to
 * show, and duplicating its order list would mean maintaining a worse copy —
 * this covers the one state Shopify cannot show, because the order never got
 * there.
 *
 * The three groups are three different problems with three different fixes, and
 * they are *server-side* queries rather than one list partitioned here. That
 * matters as soon as paging exists: fetch fifty of a mixed list and the
 * failures — the only group needing action — can sit entirely on a later page,
 * behind held orders nothing can be done about.
 */

interface GroupCopy {
  readonly label: string;
  readonly description: string;
  readonly emptyHeading: string;
  readonly emptyBody: string;
}

const GROUPS: readonly (GroupCopy & { group: StuckOrderGroup })[] = [
  {
    group: StuckOrderGroup.FAILING,
    label: 'Not getting through',
    description:
      'Tried and did not arrive. Where Shopify gave a reason it is shown under the order — fix that, then retry.',
    emptyHeading: 'Nothing is failing',
    emptyBody: 'Every order that has been attempted got through.',
  },
  {
    group: StuckOrderGroup.HELD,
    label: 'Held',
    description:
      'Waiting on a decision rather than on a failure. Release one and it goes automatically — approve it in fraud protection, or mark the phone number verified yourself.',
    emptyHeading: 'Nothing is held',
    emptyBody: 'No order is waiting on a decision from you.',
  },
  {
    group: StuckOrderGroup.WAITING,
    label: 'Queued',
    description: 'Queued and on their way. These should clear on their own within a minute or two.',
    emptyHeading: 'Nothing is queued',
    emptyBody: 'No order is waiting to be sent.',
  },
];

/** `1,000+` once a count has hit its ceiling — see `COUNT_CAP` on the server. */
function countLabel(counts: StuckOrderCounts, group: StuckOrderGroup): string {
  const value = counts[group];
  return counts.capped && value >= 1_000 ? '1,000+' : value.toLocaleString();
}

export function OrdersPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);

  const active = GROUPS[tab] ?? GROUPS[0]!;
  const query = useStuckOrders(active.group);

  const pages = query.data?.pages ?? [];
  const orders = pages.flatMap((page) => page.items);
  const counts = pages[0]?.counts;
  const total = counts ? counts.failing + counts.held + counts.waiting : 0;

  const tabs = GROUPS.map((entry) => ({
    id: entry.group,
    content: counts ? `${entry.label} (${countLabel(counts, entry.group)})` : entry.label,
  }));

  if (query.isPending) {
    return (
      <Page title="Orders">
        <SectionTabs tabs={ANALYTICS_TABS} />
        <Card>
          <SkeletonBodyText lines={8} />
        </Card>
      </Page>
    );
  }

  if (query.error) {
    return (
      <Page title="Orders" backAction={{ content: 'Home', onAction: () => navigate('/') }}>
        <SectionTabs tabs={ANALYTICS_TABS} />
        <Banner tone="critical" title="Could not load your orders">
          <p>{query.error.message}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Orders"
      subtitle="COD orders that have not reached Shopify yet"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
      titleMetadata={
        total === 0 ? (
          <Badge tone="success">All clear</Badge>
        ) : (
          <Badge tone="attention">
            {`${counts?.capped ? '1,000+' : total.toLocaleString()} waiting`}
          </Badge>
        )
      }
    >
      <SectionTabs tabs={ANALYTICS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/*
              Computed by the server across every group, not from the rows on
              screen — the warning is about the queue, and it must not vanish
              because the merchant happens to be looking at another tab.
            */}
            {pages[0]?.unattended ? (
              <Banner tone="warning" title="Orders are not being picked up">
                <BlockStack gap="200">
                  <p>
                    Some orders have been confirmed for a while and have never been attempted, which
                    usually means the CODkar background worker is not running. Until it is, orders
                    stay here and never reach Shopify, Google Sheets or your ad pixels.
                  </p>
                  <p>
                    In development it is a second terminal: <code>npm run dev:worker</code>. In
                    production it is the worker process alongside the web one.
                  </p>
                </BlockStack>
              </Banner>
            ) : null}

            {counts?.capped ? (
              <Banner tone="warning" title="More than a thousand orders are stuck">
                <p>
                  Counts stop at 1,000 — an exact figure would cost a full scan of your orders on
                  every load. Something upstream is wrong: check the worker is running and that
                  pushes are not failing in bulk.
                </p>
              </Banner>
            ) : null}

            {total === 0 ? (
              <Card>
                <EmptyState
                  heading="Every order has reached Shopify"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    Orders appear here only when they are stuck. An empty list is the healthy state
                    — your COD orders are in Shopify with the rest of your orders.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              <Card>
                <BlockStack gap="300">
                  <Tabs tabs={tabs} selected={tab} onSelect={setTab} />

                  <Text as="p" variant="bodySm" tone="subdued">
                    {active.description}
                  </Text>

                  {orders.length === 0 ? (
                    <Box>
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">
                          {active.emptyHeading}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {active.emptyBody}
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <BlockStack gap="200">
                      {orders.map((order) => (
                        <StuckOrderRow key={order.reference} order={order} />
                      ))}
                    </BlockStack>
                  )}

                  {query.hasNextPage ? (
                    <InlineStack align="center">
                      <Button
                        loading={query.isFetchingNextPage}
                        onClick={() => void query.fetchNextPage()}
                      >
                        {`Load more (${orders.length} of ${countLabel(
                          counts ?? { failing: 0, held: 0, waiting: 0, capped: false },
                          active.group,
                        )} shown)`}
                      </Button>
                    </InlineStack>
                  ) : null}
                </BlockStack>
              </Card>
            )}

            {counts && counts.held > 0 ? (
              <Banner
                tone="info"
                action={{
                  content: 'Open fraud protection',
                  onAction: () => navigate('/settings/fraud'),
                }}
              >
                <p>
                  Orders held for review are released from the fraud screen, where you can see the
                  risk score and the signals behind it.
                </p>
              </Banner>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

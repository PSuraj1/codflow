import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from '@shopify/polaris';
import { useSession } from '../hooks/useSession';
import { useAnalyticsOverview, type AnalyticsRangeState } from '../hooks/useAnalytics';
import { StoreHealthCard } from '../components/StoreHealthCard';
import { SetupGuideCard } from '../components/SetupGuideCard';
import { StatTile } from '../components/charts/StatTile';
import { ChartFrame } from '../components/charts/ChartFrame';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { RangePicker, comparisonLabelFor } from '../components/charts/RangePicker';
import { compactNumber, formatDayFull, formatMoney } from '../components/charts/chartTokens';

/**
 * The dashboard.
 *
 * What a merchant opens the app to see, so it answers the four questions they
 * actually have — how many orders, worth how much, is anything broken, and what
 * needs my attention right now — and then gets out of the way. The deeper cuts
 * live on the analytics screen; putting them here would bury the four.
 *
 * The top row is stat tiles rather than charts on purpose. Each of those
 * numbers is a single figure, and a plot area around a single figure is the
 * most common way a dashboard misses its own point.
 */
export function HomePage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const [range, setRange] = useState<AnalyticsRangeState>({ range: '30d' });
  const { data: overview, isPending } = useAnalyticsOverview(range);

  if (!session) return null;

  const { shop, subscription } = session;
  const currency = overview?.currency ?? shop.currencyCode;

  const orderSeries = overview?.series.map((point) => ({ date: point.date, value: point.codOrders })) ?? [];
  const trend = overview?.series.slice(-12).map((point) => point.codOrders) ?? [];

  return (
    <Page
      title={shop.name ?? shop.domain}
      subtitle="Cash on delivery, at a glance"
      titleMetadata={
        <InlineStack gap="200">
          <Badge tone={subscription.status === 'ACTIVE' ? 'success' : 'attention'}>
            {subscription.plan}
          </Badge>
          {subscription.isTest ? <Badge tone="info">Test</Badge> : null}
        </InlineStack>
      }
      primaryAction={{ content: 'View analytics', onAction: () => navigate('/analytics') }}
      secondaryActions={<RangePicker value={range} onChange={setRange} />}
    >
      <BlockStack gap="400">
        {/*
          Above everything, and above the fold. A merchant whose app embed is
          off has no orders to look at, so leading with empty charts tells them
          the app does not work. This card renders nothing once it is complete
          or dismissed.
        */}
        <SetupGuideCard />

        {/*
          Today, separate from the range above it. A merchant checking the app
          mid-morning wants today's count without changing a filter, and it is
          live state rather than an aggregate — orders waiting to reach Shopify
          is a queue depth, not something that happened on a day.
        */}
        <Card>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <BlockStack gap="100">
              <Text as="h3" variant="bodySm" tone="subdued">
                Orders today
              </Text>
              <Text as="p" variant="headingLg" fontWeight="semibold">
                {overview ? overview.today.orders.toLocaleString() : '—'}
              </Text>
            </BlockStack>

            <BlockStack gap="100">
              <Text as="h3" variant="bodySm" tone="subdued">
                Revenue today
              </Text>
              <Text as="p" variant="headingLg" fontWeight="semibold">
                {overview ? formatMoney(overview.today.revenue, currency, true) : '—'}
              </Text>
            </BlockStack>

            <BlockStack gap="100">
              <Text as="h3" variant="bodySm" tone="subdued">
                Waiting for Shopify
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="headingLg" fontWeight="semibold">
                  {overview ? overview.today.pendingPush.toLocaleString() : '—'}
                </Text>
                {overview && overview.today.pendingPush > 0 ? (
                  <Button variant="plain" onClick={() => navigate('/orders')}>
                    Review
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>

            <BlockStack gap="100">
              <Text as="h3" variant="bodySm" tone="subdued">
                Held for review
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="headingLg" fontWeight="semibold">
                  {overview ? overview.today.awaitingReview.toLocaleString() : '—'}
                </Text>
                {overview && overview.today.awaitingReview > 0 ? (
                  <Button variant="plain" onClick={() => navigate('/settings/fraud')}>
                    Review
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
          </InlineGrid>
        </Card>

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <StatTile
            label="COD orders"
            value={overview ? compactNumber(overview.orders.value) : '—'}
            changePct={overview?.orders.changePct}
            direction={overview?.orders.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
            trend={trend}
            colorIndex={0}
          />

          <StatTile
            label="Revenue"
            value={overview ? formatMoney(overview.revenue.value, currency, true) : '—'}
            changePct={overview?.revenue.changePct}
            direction={overview?.revenue.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
            colorIndex={0}
          />

          <StatTile
            label="Conversion rate"
            value={overview?.conversionRate ? `${overview.conversionRate.value}%` : '—'}
            changePct={overview?.conversionRate?.changePct}
            direction={overview?.conversionRate?.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
            help="Orders submitted for every hundred shoppers who saw a COD button."
            colorIndex={0}
          />

          {/*
            A rise here is bad news, so the tile has to be told which way is up.
            Without that it would colour a doubling of cancellations green.
          */}
          <StatTile
            label="Cancellation rate"
            value={overview?.cancellationRate ? `${overview.cancellationRate.value}%` : '—'}
            changePct={overview?.cancellationRate?.changePct}
            direction={overview?.cancellationRate?.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
            invertDirection
            help="Share of COD orders cancelled after they reached Shopify."
          />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <ChartFrame
              title="Orders over time"
              subtitle={
                overview
                  ? `${formatDayFull(overview.period.from)} to ${formatDayFull(overview.period.to)}`
                  : undefined
              }
              loading={isPending}
              empty={orderSeries.every((point) => point.value === 0)}
              emptyHeading="No COD orders yet"
              emptyBody="Once shoppers start using your COD form, their orders appear here."
              table={{
                columns: [{ heading: 'Date' }, { heading: 'Orders', numeric: true }, { heading: 'Revenue', numeric: true }],
                rows:
                  overview?.series.map((point) => [
                    formatDayFull(point.date),
                    point.codOrders.toLocaleString(),
                    formatMoney(point.revenue, currency),
                  ]) ?? [],
              }}
            >
              <TimeSeriesChart
                points={orderSeries}
                metricLabel="Orders"
                formatValue={(value) => compactNumber(value)}
                colorIndex={0}
              />
            </ChartFrame>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <StoreHealthCard />
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

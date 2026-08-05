import { useState } from 'react';
import {
  Banner,
  BlockStack,
  InlineGrid,
  Layout,
  Page,
  Select,
  Tabs,
} from '@shopify/polaris';
import type { BreakdownDimension, SeriesMetric } from '@codflow/shared';
import {
  useAnalyticsBreakdown,
  useAnalyticsFunnel,
  useAnalyticsOverview,
  useRebuildStats,
  type AnalyticsRangeState,
} from '../hooks/useAnalytics';
import { ChartFrame } from '../components/charts/ChartFrame';
import { TimeSeriesChart } from '../components/charts/TimeSeriesChart';
import { StackedBarChart } from '../components/charts/StackedBarChart';
import { HorizontalBarChart } from '../components/charts/HorizontalBarChart';
import { FunnelChart } from '../components/charts/FunnelChart';
import { StatTile } from '../components/charts/StatTile';
import { RangePicker, comparisonLabelFor } from '../components/charts/RangePicker';
import { compactNumber, formatDayFull, formatMoney } from '../components/charts/chartTokens';
import { SectionTabs, ANALYTICS_TABS } from '../components/SectionTabs';

/**
 * The analytics screen.
 *
 * One range control at the top drives every card, so nothing on screen can
 * silently describe a different window from its neighbour.
 *
 * The metric selector on the time-series chart exists so that orders and
 * revenue never share a plot. Two measures on two y-scales would show them
 * tracking each other regardless of what the data does — the alignment of the
 * two axes is arbitrary, and the correlation it implies is manufactured. One
 * axis, one metric, swap between them.
 */

const METRICS: readonly { label: string; value: SeriesMetric }[] = [
  { label: 'Orders', value: 'orders' },
  { label: 'Revenue', value: 'revenue' },
  { label: 'Cancelled orders', value: 'cancelled' },
  { label: 'Returned orders', value: 'returned' },
  { label: 'High-risk orders', value: 'highRisk' },
  { label: 'Blocked attempts', value: 'blocked' },
];

const DIMENSIONS: readonly { id: BreakdownDimension; content: string }[] = [
  { id: 'country', content: 'Countries' },
  { id: 'city', content: 'Cities' },
  { id: 'product', content: 'Products' },
];

export function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRangeState>({ range: '30d' });
  const [metric, setMetric] = useState<SeriesMetric>('orders');
  const [dimensionIndex, setDimensionIndex] = useState(0);

  const dimension = DIMENSIONS[dimensionIndex]?.id ?? 'country';

  const { data: overview, isPending } = useAnalyticsOverview(range);
  const { data: breakdown, isPending: breakdownPending } = useAnalyticsBreakdown(range, dimension);
  const { data: funnel, isPending: funnelPending } = useAnalyticsFunnel(range);
  const rebuild = useRebuildStats();

  const currency = overview?.currency ?? 'USD';

  const seriesFor = (key: SeriesMetric): { date: string; value: number }[] =>
    overview?.series.map((point) => {
      switch (key) {
        case 'revenue':
          return { date: point.date, value: Number(point.revenue) };
        case 'cancelled':
          return { date: point.date, value: point.cancelledOrders };
        case 'returned':
          return { date: point.date, value: point.returnedOrders };
        case 'highRisk':
          return { date: point.date, value: point.highRiskOrders };
        case 'blocked':
          return { date: point.date, value: point.blockedAttempts };
        case 'conversion':
          return {
            date: point.date,
            value: point.formViews > 0 ? Math.round((point.formSubmissions / point.formViews) * 1_000) / 10 : 0,
          };
        default:
          return { date: point.date, value: point.codOrders };
      }
    }) ?? [];

  const points = seriesFor(metric);
  const metricLabel = METRICS.find((entry) => entry.value === metric)?.label ?? 'Orders';

  const formatMetric = (value: number): string =>
    metric === 'revenue' ? formatMoney(value, currency, true) : compactNumber(value);

  const outcomePoints =
    overview?.series.map((point) => ({
      date: point.date,
      fulfilled: point.fulfilledOrders,
      cancelled: point.cancelledOrders,
      returned: point.returnedOrders,
    })) ?? [];

  const breakdownRows = breakdown ? [...breakdown.rows, ...(breakdown.other ? [breakdown.other] : [])] : [];

  return (
    <Page
      title="Analytics"
      subtitle={
        overview
          ? `${formatDayFull(overview.period.from)} to ${formatDayFull(overview.period.to)} · ${
              overview.period.timezone
            }`
          : undefined
      }
      secondaryActions={<RangePicker value={range} onChange={setRange} />}
    >
      <SectionTabs tabs={ANALYTICS_TABS} />

      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <StatTile
            label="COD orders"
            value={overview ? compactNumber(overview.orders.value) : '—'}
            changePct={overview?.orders.changePct}
            direction={overview?.orders.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
          />
          <StatTile
            label="Revenue"
            value={overview ? formatMoney(overview.revenue.value, currency, true) : '—'}
            changePct={overview?.revenue.changePct}
            direction={overview?.revenue.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
          />
          <StatTile
            label="Average order value"
            value={overview ? formatMoney(overview.averageOrderValue.value, currency) : '—'}
            changePct={overview?.averageOrderValue.changePct}
            direction={overview?.averageOrderValue.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
          />
          <StatTile
            label="Blocked by fraud rules"
            value={overview ? compactNumber(overview.blockedAttempts.value) : '—'}
            changePct={overview?.blockedAttempts.changePct}
            direction={overview?.blockedAttempts.direction}
            comparisonLabel={comparisonLabelFor(range.range)}
            help="Orders the fraud engine refused. These are attempts, not sales, so they carry no revenue."
          />
        </InlineGrid>

        <ChartFrame
          title={metricLabel}
          subtitle="One metric at a time — two measures of different scale would need two axes, and the alignment between them would be arbitrary."
          loading={isPending}
          empty={points.every((point) => point.value === 0)}
          action={
            <Select
              label="Metric"
              labelHidden
              options={[...METRICS]}
              value={metric}
              onChange={(next) => setMetric(next as SeriesMetric)}
            />
          }
          table={{
            columns: [{ heading: 'Date' }, { heading: metricLabel, numeric: true }],
            rows: points.map((point) => [formatDayFull(point.date), formatMetric(point.value)]),
          }}
        >
          <TimeSeriesChart
            points={points}
            metricLabel={metricLabel}
            formatValue={formatMetric}
            colorIndex={metric === 'revenue' ? 1 : 0}
          />
        </ChartFrame>

        <Layout>
          <Layout.Section>
            <ChartFrame
              title="What happened to your orders"
              subtitle="Delivered is the only outcome that turns a COD order into money."
              loading={isPending}
              empty={outcomePoints.every(
                (point) => point.fulfilled + point.cancelled + point.returned === 0,
              )}
              emptyHeading="No outcomes recorded yet"
              emptyBody="Deliveries, cancellations and refunds appear here as Shopify reports them."
              table={{
                columns: [
                  { heading: 'Date' },
                  { heading: 'Delivered', numeric: true },
                  { heading: 'Cancelled', numeric: true },
                  { heading: 'Returned', numeric: true },
                ],
                rows: outcomePoints.map((point) => [
                  formatDayFull(point.date),
                  point.fulfilled.toLocaleString(),
                  point.cancelled.toLocaleString(),
                  point.returned.toLocaleString(),
                ]),
              }}
            >
              <StackedBarChart points={outcomePoints} />
            </ChartFrame>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <ChartFrame
              title="COD funnel"
              subtitle="Where shoppers drop out."
              loading={funnelPending}
              empty={(funnel?.stages.length ?? 0) === 0}
              table={{
                columns: [
                  { heading: 'Stage' },
                  { heading: 'Count', numeric: true },
                  { heading: 'Of previous', numeric: true },
                ],
                rows:
                  funnel?.stages.map((stage) => [
                    stage.label,
                    stage.count.toLocaleString(),
                    stage.conversionFromPrevious === null ? '—' : `${stage.conversionFromPrevious}%`,
                  ]) ?? [],
              }}
            >
              <BlockStack gap="400">
                {funnel?.viewsMissing ? (
                  /*
                    Without view telemetry the first two stages are unknown
                    rather than zero. Drawing them as zero would show a funnel
                    starting below its own second stage, which reads as a data
                    fault and discredits the stages that are real.
                  */
                  <Banner tone="info">
                    <p>
                      Storefront view tracking has not reported yet, so this funnel starts at submitted
                      orders. It fills in once shoppers load a page with a COD button.
                    </p>
                  </Banner>
                ) : null}

                <FunnelChart stages={funnel?.stages ?? []} />
              </BlockStack>
            </ChartFrame>
          </Layout.Section>
        </Layout>

        <ChartFrame
          title="Where your orders come from"
          loading={breakdownPending}
          empty={breakdownRows.length === 0}
          emptyHeading="No breakdown yet"
          emptyBody="Countries, cities and products appear here once orders come through."
          action={
            <Tabs
              tabs={DIMENSIONS.map((entry) => ({ id: entry.id, content: entry.content }))}
              selected={dimensionIndex}
              onSelect={setDimensionIndex}
              fitted
            />
          }
          table={{
            columns: [
              { heading: DIMENSIONS[dimensionIndex]?.content ?? 'Country' },
              { heading: 'Orders', numeric: true },
              { heading: 'Share', numeric: true },
              { heading: 'Revenue', numeric: true },
            ],
            rows: breakdownRows.map((row) => [
              row.label,
              row.orders.toLocaleString(),
              `${row.share}%`,
              formatMoney(row.revenue, currency),
            ]),
          }}
        >
          <HorizontalBarChart
            data={breakdownRows.map((row) => ({
              key: row.key,
              label: row.label,
              value: row.orders,
              secondary: formatMoney(row.revenue, currency, true),
            }))}
            formatValue={(value) => value.toLocaleString()}
          />
        </ChartFrame>

        {/*
          The answer to "these numbers look wrong". Counters are incremented as
          events happen and can drift — a webhook retried after the handler
          already ran, a deploy that dropped an in-flight increment — so there
          has to be a way to restate them from the orders themselves without
          anyone touching the database.
        */}
        {overview ? (
          <Banner
            tone="info"
            title="Numbers not adding up?"
            action={{
              content: rebuild.isPending ? 'Rebuilding…' : 'Rebuild from orders',
              onAction: () => rebuild.mutate({ from: overview.period.from, to: overview.period.to }),
              disabled: rebuild.isPending,
            }}
          >
            <p>
              Recalculates every figure for this range directly from your orders. Storefront view counts
              are kept as they are — they have no other source.
            </p>
          </Banner>
        ) : null}
      </BlockStack>
    </Page>
  );
}

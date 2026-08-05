import { useId, useState, type ReactNode } from 'react';
import {
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';

/**
 * The card every chart sits in.
 *
 * Its real job is the table view. Three of the palette's steps fall below 3:1
 * contrast on Polaris's light surface, and the rule that makes that acceptable
 * is that no chart may carry meaning through color alone — so every chart here
 * ships an equivalent table, one keypress from the chart, containing the same
 * numbers. That covers the contrast case, colorblind readers, screen readers,
 * and the merchant who just wants to copy the figures into a spreadsheet.
 *
 * It also owns the three states a chart is actually in — loading, empty, and
 * rendered — because getting those wrong is what produces a dashboard that
 * shows "0" while it is still fetching and teaches merchants to distrust it.
 */

export interface ChartTableColumn {
  readonly heading: string;
  readonly numeric?: boolean;
}

export interface ChartFrameProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Rendered to the right of the title — a metric selector, a range picker. */
  readonly action?: ReactNode;
  readonly loading?: boolean;
  /** True when there is genuinely nothing to plot, as opposed to still loading. */
  readonly empty?: boolean;
  readonly emptyHeading?: string;
  readonly emptyBody?: string;
  /** Columns and rows of the equivalent table. Required — see above. */
  readonly table: {
    readonly columns: readonly ChartTableColumn[];
    readonly rows: readonly (readonly string[])[];
  };
  readonly children: ReactNode;
}

export function ChartFrame({
  title,
  subtitle,
  action,
  loading = false,
  empty = false,
  emptyHeading = 'Nothing to show yet',
  emptyBody = 'This chart fills in as orders come through.',
  table,
  children,
}: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const regionId = useId();

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" gap="200" wrap={false}>
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">
              {title}
            </Text>
            {subtitle ? (
              <Text as="p" variant="bodySm" tone="subdued">
                {subtitle}
              </Text>
            ) : null}
          </BlockStack>

          <InlineStack gap="200" blockAlign="center" wrap={false}>
            {action}
            {!empty && !loading ? (
              <Button
                variant="tertiary"
                size="slim"
                onClick={() => setShowTable((current) => !current)}
                ariaExpanded={showTable}
                ariaControls={regionId}
              >
                {showTable ? 'Show chart' : 'Show table'}
              </Button>
            ) : null}
          </InlineStack>
        </InlineStack>

        <Box id={regionId}>
          {loading ? (
            <SkeletonBodyText lines={6} />
          ) : empty ? (
            <EmptyState heading={emptyHeading} image="">
              <p>{emptyBody}</p>
            </EmptyState>
          ) : showTable ? (
            <DataTable
              columnContentTypes={table.columns.map((column) => (column.numeric ? 'numeric' : 'text'))}
              headings={table.columns.map((column) => column.heading)}
              rows={table.rows.map((row) => [...row])}
              increasedTableDensity
            />
          ) : (
            children
          )}
        </Box>
      </BlockStack>
    </Card>
  );
}

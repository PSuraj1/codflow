import { Select } from '@shopify/polaris';
import type { AnalyticsRange } from '@codflow/shared';
import type { AnalyticsRangeState } from '../../hooks/useAnalytics';

/**
 * The date range every chart on a screen shares.
 *
 * One control above the charts rather than one per card, because a dashboard
 * where each chart carries its own range is a dashboard where two cards
 * silently describe different weeks — and nothing on screen says so.
 *
 * Presets only. A custom range is supported by the API and reachable from the
 * analytics screen; putting a date-pair control in the summary header would
 * cost more space than the option is worth at a glance.
 */

const OPTIONS: readonly { label: string; value: AnalyticsRange }[] = [
  { label: 'Today', value: 'today' },
  { label: 'Last 7 days', value: '7d' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 90 days', value: '90d' },
  { label: 'Month to date', value: 'mtd' },
];

export interface RangePickerProps {
  readonly value: AnalyticsRangeState;
  readonly onChange: (value: AnalyticsRangeState) => void;
  readonly labelHidden?: boolean;
}

export function RangePicker({ value, onChange, labelHidden = true }: RangePickerProps) {
  return (
    <Select
      label="Date range"
      labelHidden={labelHidden}
      options={[...OPTIONS]}
      value={value.range === 'custom' ? '30d' : value.range}
      onChange={(next) => onChange({ range: next as AnalyticsRange })}
    />
  );
}

/** How the comparison reads in a stat tile, for each preset. */
export function comparisonLabelFor(range: AnalyticsRange): string {
  switch (range) {
    case 'today':
      return 'vs yesterday';
    case '7d':
      return 'vs previous 7 days';
    case '30d':
      return 'vs previous 30 days';
    case '90d':
      return 'vs previous 90 days';
    case 'mtd':
      return 'vs the same days last month';
    default:
      return 'vs previous period';
  }
}

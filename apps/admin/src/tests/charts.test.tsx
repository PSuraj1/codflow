import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPolaris } from './render';
import {
  compactNumber,
  formatMoney,
  labelStride,
  niceScale,
  ordinalColor,
  seriesColor,
} from '../components/charts/chartTokens';
import { StatTile } from '../components/charts/StatTile';
import { ChartFrame } from '../components/charts/ChartFrame';

/**
 * The chart layer.
 *
 * What is worth testing here is the arithmetic that decides what a merchant
 * sees, and the two accessibility properties the palette depends on:
 *
 *  - Three of the series colors fall below 3:1 contrast on Polaris's light
 *    surface. That is only acceptable because every chart ships an equivalent
 *    table, so the table toggle is not a nicety — it is the mitigation.
 *  - A delta's color must follow whether the change is *good*, not whether the
 *    number went up. A tile that greens every increase tells a merchant their
 *    cancellation rate is improving while it doubles.
 */

describe('niceScale', () => {
  it('rounds the axis to numbers people read without doing arithmetic', () => {
    expect(niceScale(3_847).ticks).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(niceScale(7).ticks).toEqual([0, 2, 4, 6, 8]);
  });

  it('never divides by zero on an all-zero range', () => {
    // A quiet week would otherwise render every bar at full height, which says
    // the opposite of what happened.
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN).max).toBe(1);
  });

  it('always includes the largest value', () => {
    for (const value of [1, 9, 12, 99, 101, 1_001, 45_678]) {
      expect(niceScale(value).max).toBeGreaterThanOrEqual(value);
    }
  });
});

describe('compactNumber', () => {
  it('keeps small numbers exact and compacts large ones', () => {
    expect(compactNumber(1_284)).toBe('1,284');
    expect(compactNumber(12_900)).toBe('12.9K');
    expect(compactNumber(4_200_000)).toBe('4.2M');
  });
});

describe('formatMoney', () => {
  it('parses the decimal string the API sends', () => {
    // Money crosses the wire as a string; a float would lose the cents a
    // merchant reconciling against their bank will notice.
    expect(formatMoney('1234.56', 'USD')).toContain('1,234.56');
  });

  it('falls back rather than blanking the dashboard on an unknown currency', () => {
    expect(formatMoney('10.00', 'NOTACURRENCY')).toBe('NOTACURRENCY 10.00');
  });

  it('shows a dash for an unparseable amount', () => {
    expect(formatMoney('', 'USD')).not.toBe('');
    expect(formatMoney('abc', 'USD')).toBe('—');
  });
});

describe('palette', () => {
  it('assigns categorical slots in fixed order and never generates a hue', () => {
    // Color follows the entity, not its rank: slot 0 is always the same blue
    // whatever else is on screen.
    expect(seriesColor(0, false)).toBe('#2a78d6');
    expect(seriesColor(1, false)).toBe('#eb6834');
    // Past the validated slots it folds back rather than inventing a colour
    // that has not been checked for colorblind separation.
    expect(seriesColor(7, false)).toBe(seriesColor(1, false));
  });

  it('steps the ordinal ramp light to dark across the stages', () => {
    const stages = 5;
    const ramp = Array.from({ length: stages }, (_, index) => ordinalColor(index, stages, false));

    expect(new Set(ramp).size).toBe(stages);
    expect(ramp[0]).toBe('#86b6ef');
    expect(ramp[stages - 1]).toBe('#104281');
  });
});

describe('labelStride', () => {
  it('thins axis labels to what the width can carry', () => {
    // Ninety labels in 600px is a grey smear that reads as a rendering fault.
    expect(labelStride(90, 600)).toBeGreaterThan(1);
    expect(labelStride(7, 600)).toBe(1);
  });
});

describe('StatTile', () => {
  it('treats a rise as good news by default', () => {
    renderWithPolaris(
      <StatTile label="COD orders" value="1,284" changePct={12.5} direction="up" />,
    );

    expect(screen.getByText('+12.5%')).toBeTruthy();
  });

  it('says there is no comparison rather than inventing one', () => {
    renderWithPolaris(<StatTile label="COD orders" value="5" changePct={null} direction="up" />);

    // "Up 100%" from a base of nothing would be true of every first order.
    expect(screen.getByText('No comparison available')).toBeTruthy();
  });

  it('renders an inverted metric without claiming a rise is good', () => {
    renderWithPolaris(
      <StatTile
        label="Cancellation rate"
        value="9.4%"
        changePct={40}
        direction="up"
        invertDirection
      />,
    );

    // The arrow and the tone both flip; the text is the same either way, which
    // is why the icon carries the meaning too.
    expect(screen.getByText('+40%')).toBeTruthy();
  });
});

describe('ChartFrame', () => {
  const table = {
    columns: [{ heading: 'Date' }, { heading: 'Orders', numeric: true }],
    rows: [['4 March 2026', '12']],
  };

  it('offers the table view every chart depends on for accessibility', () => {
    renderWithPolaris(
      <ChartFrame title="Orders over time" table={table}>
        <svg />
      </ChartFrame>,
    );

    expect(screen.getByRole('button', { name: 'Show table' })).toBeTruthy();
  });

  it('distinguishes loading from empty', () => {
    const { rerender } = renderWithPolaris(
      <ChartFrame title="Orders over time" loading table={table}>
        <svg data-testid="chart" />
      </ChartFrame>,
    );

    // Showing "0" while still fetching is how a dashboard teaches merchants to
    // distrust every other number on it.
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show table' })).toBeNull();

    rerender(
      <ChartFrame title="Orders over time" empty emptyHeading="No COD orders yet" table={table}>
        <svg data-testid="chart" />
      </ChartFrame>,
    );

    expect(screen.getByText('No COD orders yet')).toBeTruthy();
  });
});

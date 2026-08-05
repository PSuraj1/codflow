import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  ANALYTICS_TABS,
  COD_FORM_TABS,
  SETTINGS_TABS,
  SectionTabs,
  tabIndexFor,
} from '../components/SectionTabs';

/**
 * Section grouping.
 *
 * App Bridge's nav menu cannot nest, so sections are tab strips shared by
 * several routes. The property that matters is that each tab is a *route*
 * rather than component state — the dashboard links straight to `/orders`,
 * Store health to `/settings/pixels`, and Google's OAuth callback returns to
 * `/settings/sheets?google_connected=1`. If the selected tab were local state,
 * every one of those would land on the section's first tab instead.
 */

function Harness({
  at,
  tabs,
}: {
  at: string;
  tabs: readonly { label: string; path: string }[];
}) {
  function Probe() {
    const location = useLocation();
    return <span data-testid="path">{location.pathname}</span>;
  }

  return (
    <AppProvider i18n={enTranslations}>
      <MemoryRouter initialEntries={[at]}>
        <SectionTabs tabs={tabs} />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </AppProvider>
  );
}

function selectedTab(): string | null {
  const selected = document.querySelector('[aria-selected="true"]');
  return selected?.textContent ?? null;
}

describe('tabIndexFor', () => {
  it('resolves each section path to its own tab', () => {
    expect(tabIndexFor('/analytics', ANALYTICS_TABS)).toBe(0);
    expect(tabIndexFor('/orders', ANALYTICS_TABS)).toBe(1);
    expect(tabIndexFor('/settings/fraud', SETTINGS_TABS)).toBe(4);
    expect(tabIndexFor('/settings/backup', SETTINGS_TABS)).toBe(5);
  });

  it('keeps a drill-down on its parent tab', () => {
    expect(tabIndexFor('/forms/cms7biy4l0005', COD_FORM_TABS)).toBe(0);
  });

  it('falls back to the first tab rather than to none', () => {
    expect(tabIndexFor('/somewhere-else', COD_FORM_TABS)).toBe(0);
  });

  /** `/settings/appearance` must not be swallowed by a `/settings` prefix. */
  it('does not confuse sibling paths that share a prefix', () => {
    expect(tabIndexFor('/settings/appearance', COD_FORM_TABS)).toBe(1);
    expect(tabIndexFor('/settings/sheets', SETTINGS_TABS)).toBe(2);
  });
});

describe('the selected tab follows the URL', () => {
  it('marks the tab for the route being shown', () => {
    render(<Harness at="/orders" tabs={ANALYTICS_TABS} />);
    expect(selectedTab()).toBe('Orders');
  });

  it('marks a different tab for a different route in the same section', () => {
    render(<Harness at="/analytics" tabs={ANALYTICS_TABS} />);
    expect(selectedTab()).toBe('Overview');
  });

  /** The screen Google's OAuth callback returns merchants to. */
  it('lands on Google Sheets rather than the section default', () => {
    render(<Harness at="/settings/sheets" tabs={SETTINGS_TABS} />);
    expect(selectedTab()).toBe('Google Sheets');
  });

  it('lands on Ad pixels when Store health links there', () => {
    render(<Harness at="/settings/pixels" tabs={SETTINGS_TABS} />);
    expect(selectedTab()).toBe('Ad pixels');
  });

  /**
   * The form builder is a drill-down, not a fourth tab — it should not look
   * like it left the section it was opened from.
   */
  it('keeps the parent tab selected on a drill-down', () => {
    render(<Harness at="/forms/cms7biy4l0005" tabs={COD_FORM_TABS} />);
    expect(selectedTab()).toBe('Forms');
  });

  it('falls back to the first tab for a path outside the section', () => {
    render(<Harness at="/somewhere-else" tabs={COD_FORM_TABS} />);
    expect(selectedTab()).toBe('Forms');
  });
});

describe('choosing a tab', () => {
  /**
   * The rendered control is not clicked here. Polaris measures tab widths to
   * decide its overflow menu, and jsdom reports every width as zero — so it
   * renders duplicate tab elements whose clicks never reach `onSelect`. What
   * that leaves untested is the one-line handler itself; the rule it applies is
   * covered above and below.
   */
  it('maps a tab index back to its route', () => {
    expect(COD_FORM_TABS[1]?.path).toBe('/settings/appearance');
    expect(ANALYTICS_TABS[1]?.path).toBe('/orders');
  });
});

describe('the sections themselves', () => {
  /** Every tab must be a route the app actually declares. */
  it('point at the canonical paths the rest of the app links to', () => {
    expect(ANALYTICS_TABS.map((tab) => tab.path)).toEqual(['/analytics', '/orders']);
    expect(COD_FORM_TABS.map((tab) => tab.path)).toEqual([
      '/forms',
      '/settings/appearance',
      '/buttons',
    ]);
    expect(SETTINGS_TABS.map((tab) => tab.path)).toEqual([
      '/settings/visibility',
      '/settings/fees',
      '/settings/sheets',
      '/settings/pixels',
      '/settings/fraud',
      '/settings/backup',
    ]);
  });
});

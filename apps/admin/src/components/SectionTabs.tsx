import { useLocation, useNavigate } from 'react-router-dom';
import { Tabs } from '@shopify/polaris';

/**
 * Grouping for a sidebar that cannot group.
 *
 * App Bridge's `ui-nav-menu` renders a single flat level — Shopify's docs are
 * explicit that navigation items cannot nest — so a section is expressed as a
 * tab strip shared by several routes rather than as a parent nav entry.
 *
 * Each tab is a **route**, not local state. That is what keeps every deep link
 * in the app working: the dashboard sends merchants to `/orders`, Store health
 * to `/settings/pixels`, and Google's OAuth callback returns to
 * `/settings/sheets?google_connected=1`. Had the tabs been component state,
 * every one of those would have landed on the section's first tab instead.
 */

export interface SectionTab {
  readonly label: string;
  readonly path: string;
}

/** Analytics and its operational sibling. */
export const ANALYTICS_TABS: readonly SectionTab[] = [
  { label: 'Overview', path: '/analytics' },
  { label: 'Orders', path: '/orders' },
];

/** Everything that decides what a shopper sees. */
export const COD_FORM_TABS: readonly SectionTab[] = [
  { label: 'Forms', path: '/forms' },
  { label: 'Appearance', path: '/settings/appearance' },
  { label: 'Button', path: '/buttons' },
];

export const SETTINGS_TABS: readonly SectionTab[] = [
  { label: 'Visibility', path: '/settings/visibility' },
  { label: 'Fees', path: '/settings/fees' },
  { label: 'Google Sheets', path: '/settings/sheets' },
  { label: 'Ad pixels', path: '/settings/pixels' },
  { label: 'Fraud protection', path: '/settings/fraud' },
  { label: 'Import / export', path: '/settings/backup' },
];

/**
 * Which tab a path belongs to.
 *
 * A drill-down keeps its section highlighted: `/forms/:formId` is still the
 * Forms tab, so the builder does not appear to leave the section it was opened
 * from. An unknown path falls back to the first tab rather than to none, which
 * would render a tab strip with nothing selected.
 *
 * Exported so it can be tested directly. Polaris measures tab widths to decide
 * what to put in its overflow menu, and with no layout in jsdom that produces
 * duplicate elements whose clicks do not reach the handler — so the selection
 * rule is verified here rather than through the rendered control.
 */
export function tabIndexFor(pathname: string, tabs: readonly SectionTab[]): number {
  const index = tabs.findIndex(
    (tab) => pathname === tab.path || pathname.startsWith(`${tab.path}/`),
  );

  return index === -1 ? 0 : index;
}

export function SectionTabs({ tabs }: { tabs: readonly SectionTab[] }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Tabs
      tabs={tabs.map((tab) => ({ id: tab.path, content: tab.label }))}
      selected={tabIndexFor(pathname, tabs)}
      onSelect={(selected) => {
        const target = tabs[selected];
        if (target) navigate(target.path);
      }}
    />
  );
}

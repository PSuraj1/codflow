import type { ReactNode } from 'react';
import { Banner, BlockStack, Card, Layout, Page, SkeletonBodyText, Spinner } from '@shopify/polaris';
import { useSession } from '../hooks/useSession';
import { ApiError } from '../lib/apiClient';
import { openTop } from '../lib/appBridge';
import { SupportWidget } from './SupportWidget';

/**
 * Gate between App Bridge booting and the app rendering.
 *
 * Nothing below this component can render usefully without a session — every
 * screen needs the shop's currency, plan and branding — so this resolves it
 * once and holds back the tree until it is available.
 *
 * The three states it distinguishes are the three a merchant can actually be
 * in, and conflating them is what produces the "app just doesn't load" reports:
 * still loading, a recoverable permissions problem, and a hard failure.
 */

export function AppShell({ children }: { children: ReactNode }) {
  const { data: session, isPending, error, refetch } = useSession();

  if (isPending) {
    return (
      <Page title="CODkar">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400" inlineAlign="center">
                <Spinner accessibilityLabel="Loading CODkar" size="large" />
                <SkeletonBodyText lines={3} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  if (error) {
    const apiError = error instanceof ApiError ? error : null;

    return (
      <Page title="CODkar">
        <Banner
          tone="critical"
          title="CODkar could not start"
          action={{ content: 'Try again', onAction: () => void refetch() }}
        >
          <p>{apiError?.body.message ?? error.message}</p>
          {apiError ? <p>Request ID: {apiError.body.requestId}</p> : null}
        </Banner>
      </Page>
    );
  }

  return (
    <>
      {/*
        Shopify's own navigation, rendered into the admin's left sidebar rather
        than inside the app frame. `ui-nav-menu` is a custom element App Bridge
        defines, so React treats it as unknown markup and passes it through
        untouched — which is what we want. The first anchor must point at "/"
        and is used only as the app's title; Shopify hides it from the list.

        The list is flat because `ui-nav-menu` cannot nest — Shopify's docs are
        explicit that navigation items may not contain other items, and the
        guidance is to group related pages instead. So each entry here is a
        *section*, and the pages within it share a tab strip (`SectionTabs`).
        Adding a screen means adding it to that section's tab list, not to this
        menu — nine top-level entries was already more than this app needs.
      */}
      <ui-nav-menu>
        <a href="/" rel="home">
          CODkar
        </a>
        <a href="/analytics">Analytics</a>
        <a href="/forms">COD forms</a>
        <a href="/upsells">Upsells</a>
        <a href="/settings">Settings</a>
        <a href="/settings/billing">Plan and usage</a>
      </ui-nav-menu>

      {/*
        Scopes can fall short without the app being unusable — a missing
        `read_themes` breaks the theme-extension check and nothing else. So this
        is a banner above a working app rather than a wall in front of it. The
        button escapes the iframe, because Shopify's consent screen refuses to
        render inside one.
      */}
      {!session.scopes.satisfied ? (
        <Banner
          tone="warning"
          title="CODkar needs additional permissions"
          action={{
            content: 'Update permissions',
            onAction: () =>
              openTop(`/api/auth/reauthorize?shop=${encodeURIComponent(session.shop.domain)}`),
          }}
        >
          <p>
            Some features are unavailable until these permissions are granted:{' '}
            {session.scopes.missing.join(', ')}.
          </p>
        </Banner>
      ) : null}

      {children}

      {/*
        Outside `{children}`, so it survives every route change and is present
        on the screens a merchant is most likely to be stuck on.
      */}
      <SupportWidget />
    </>
  );
}

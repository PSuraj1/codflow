import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  EmptyState,
  Layout,
  Page,
  SkeletonBodyText,
} from '@shopify/polaris';
import { PLAN_LIMITS, type PixelSummary } from '@codflow/shared';
import { usePixels } from '../hooks/usePixels';
import { useSession } from '../hooks/useSession';
import { PixelCard } from '../components/pixels/PixelCard';
import { PixelForm } from '../components/pixels/PixelForm';
import { EventLog } from '../components/pixels/EventLog';
import { SectionTabs, SETTINGS_TABS } from '../components/SectionTabs';

/**
 * Ad pixels.
 *
 * Until now every one of these endpoints existed and no screen reached them, so
 * client-side firing worked and a merchant had no way to switch it on. This is
 * that screen.
 *
 * Plan state is read from the session and shown before the merchant fills in a
 * form, not after: both gates here are configuration-time refusals — the pixel
 * count and server-side tracking — and being told "upgrade" having already
 * pasted a Conversions API token is a waste of their time.
 */
export function PixelsPage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: pixels, isPending, error } = usePixels();

  const [editing, setEditing] = useState<PixelSummary | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  if (isPending) {
    return (
      <Page title="Ad pixels">
        <SectionTabs tabs={SETTINGS_TABS} />
        <Card>
          <SkeletonBodyText lines={10} />
        </Card>
      </Page>
    );
  }

  if (error || !pixels) {
    return (
      <Page title="Ad pixels">
        <SectionTabs tabs={SETTINGS_TABS} />
        <Banner tone="critical" title="Could not load your pixels">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const limits = session ? PLAN_LIMITS[session.subscription.plan] : null;
  const limit = limits?.pixels ?? null;
  const atLimit = limit !== null && pixels.length >= limit;
  const serverSideAllowed = limits?.serverSideTracking ?? false;

  const live = pixels.filter((pixel) => pixel.isEnabled).length;

  const openForm = (pixel: PixelSummary | null) => {
    setEditing(pixel);
    setFormOpen(true);
  };

  return (
    <Page
      title="Ad pixels"
      subtitle="Report COD orders to Meta, Google and the rest"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
      titleMetadata={
        pixels.length > 0 ? <Badge tone={live > 0 ? 'success' : 'warning'}>{`${live} live`}</Badge> : null
      }
      primaryAction={{
        content: 'Add pixel',
        onAction: () => openForm(null),
        disabled: atLimit,
        helpText: atLimit
          ? `Your plan includes ${limit} pixel${limit === 1 ? '' : 's'}.`
          : undefined,
      }}
    >
      <SectionTabs tabs={SETTINGS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/*
              The one thing about COD tracking that is not obvious, and the
              reason server-side matters more here than on a normal store: the
              shopper is long gone by the time the order is real.
            */}
            <Banner tone="info">
              <p>
                A COD order is confirmed after the shopper has closed the tab, so the sale can only
                be reported from CodFlow&rsquo;s server. Browser tracking alone will under-report
                your conversions.
              </p>
            </Banner>

            {!serverSideAllowed ? (
              <Banner
                tone="warning"
                title="Server-side tracking is not on your plan"
                action={{ content: 'See plans', onAction: () => navigate('/settings/billing') }}
              >
                <p>
                  Browser tracking works on every plan. Without server-side sending, orders placed
                  through the COD form are not reported to your ad platforms.
                </p>
              </Banner>
            ) : null}

            {atLimit ? (
              <Banner
                tone="info"
                action={{ content: 'See plans', onAction: () => navigate('/settings/billing') }}
              >
                <p>
                  You are using all {limit} pixel{limit === 1 ? '' : 's'} on your plan. Remove one
                  to add another.
                </p>
              </Banner>
            ) : null}

            {pixels.length === 0 ? (
              <Card>
                <EmptyState
                  heading="No ad pixels yet"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  action={{ content: 'Add your first pixel', onAction: () => openForm(null) }}
                >
                  <p>
                    Connect Meta, Google Ads, TikTok, Snapchat or Pinterest and CodFlow will report
                    every COD order as a conversion.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              pixels.map((pixel) => (
                <PixelCard key={pixel.id} pixel={pixel} onEdit={() => openForm(pixel)} />
              ))
            )}

            <EventLog />
          </BlockStack>
        </Layout.Section>
      </Layout>

      {formOpen ? (
        // Keyed so opening the form for a different pixel starts from that
        // pixel's values rather than the previous one's.
        <PixelForm
          key={editing?.id ?? 'new'}
          pixel={editing}
          open={formOpen}
          onClose={() => setFormOpen(false)}
        />
      ) : null}
    </Page>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Page,
  SkeletonBodyText,
  Tabs,
} from '@shopify/polaris';
import { PLAN_LIMITS } from '@codflow/shared';
import { useButtons } from '../hooks/useButtons';
import { useSession } from '../hooks/useSession';
import { ButtonEditor } from '../components/buttons/ButtonEditor';
import { PLACEMENT_COPY } from '../components/buttons/placements';
import { SectionTabs, COD_FORM_TABS } from '../components/SectionTabs';

/**
 * The COD button customizer.
 *
 * One tab per placement rather than one long page: the settings are identical
 * across placements, so stacked they would read as six near-identical forms and
 * a merchant would lose track of which one they were editing. The tab label
 * carries the on/off state, which is the thing they are usually looking for.
 *
 * Plan entitlement is read from the session rather than fetched — it is already
 * there, and `PLAN_LIMITS` is the same table the server gates against.
 */
export function ButtonsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);

  const { data: session } = useSession();
  const { data: buttons, isPending, error } = useButtons();

  if (isPending) {
    return (
      <Page title="COD button">
        <Card>
          <SkeletonBodyText lines={12} />
        </Card>
      </Page>
    );
  }

  if (error || !buttons) {
    return (
      <Page title="COD button">
        <Banner tone="critical" title="Could not load your buttons">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const customCssAllowed = session ? PLAN_LIMITS[session.subscription.plan].customCss : false;

  const selected = buttons[Math.min(tab, buttons.length - 1)];
  const liveCount = buttons.filter((button) => button.isEnabled).length;

  const tabs = buttons.map((button) => ({
    id: button.placement,
    content: PLACEMENT_COPY[button.placement].title,
    // Read by screen readers in place of the visual on/off state below.
    accessibilityLabel: `${PLACEMENT_COPY[button.placement].title} — ${
      button.isEnabled ? 'on' : 'off'
    }`,
  }));

  return (
    <Page
      title="COD button"
      subtitle="How your cash-on-delivery button looks, and where it appears"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
      titleMetadata={
        liveCount > 0 ? (
          <Badge tone="success">{`${liveCount} live`}</Badge>
        ) : (
          <Badge tone="warning">None showing</Badge>
        )
      }
    >
      <SectionTabs tabs={COD_FORM_TABS} />

      <BlockStack gap="400">
        {liveCount === 0 ? (
          <Banner tone="warning" title="No COD button is showing on your storefront">
            <p>Switch on at least one placement below, or shoppers have no way to order.</p>
          </Banner>
        ) : null}

        <Tabs tabs={tabs} selected={Math.min(tab, buttons.length - 1)} onSelect={setTab} />

        {selected ? (
          // Keyed so switching tabs starts a fresh draft rather than carrying
          // one placement's unsaved edits into another's fields.
          <ButtonEditor
            key={selected.placement}
            button={selected}
            customCssAllowed={customCssAllowed}
          />
        ) : null}
      </BlockStack>
    </Page>
  );
}

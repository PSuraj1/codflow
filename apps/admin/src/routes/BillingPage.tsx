import { useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import type { Plan } from '@codflow/shared';
import { useBilling, useOpenPricingPage, useRefreshSubscription } from '../hooks/useBilling';
import { PlanCard } from '../components/billing/PlanCard';
import { UsageMeter } from '../components/billing/UsageMeter';

/**
 * Plan and usage.
 *
 * Two jobs, in this order: tell the merchant where they stand against their
 * caps, and make changing plan one click. The usage meters come first because
 * that is what brings anyone to this screen — nobody opens a billing page to
 * admire the tiers.
 *
 * Every state that can gate a merchant gets a banner that names the state and
 * what to do about it. A frozen subscription in particular has to be spelled
 * out: from inside the app it looks identical to a downgrade, but the cause is
 * the merchant's own unpaid Shopify invoice and nothing they do here will fix
 * it.
 */

function statusBanner(
  status: string,
  planName: string,
  trialDaysRemaining: number | null,
): { tone: 'info' | 'warning' | 'critical'; title: string; body: string } | null {
  switch (status) {
    case 'TRIALING':
      return {
        tone: 'info',
        title:
          trialDaysRemaining === null
            ? `You are trialling ${planName}`
            : `${trialDaysRemaining} day${trialDaysRemaining === 1 ? '' : 's'} left of your ${planName} trial`,
        body: 'Shopify starts billing when the trial ends. Cancel any time from your Shopify admin.',
      };

    case 'FROZEN':
      return {
        tone: 'critical',
        title: `Your ${planName} plan is paused`,
        body: 'Shopify has frozen this subscription, which usually means your own Shopify invoice is unpaid. Your settings are untouched, but limits are back to the free plan until it is settled.',
      };

    case 'CANCELLED':
      return {
        tone: 'warning',
        title: `Your ${planName} plan was cancelled`,
        body: 'You are on the free plan limits now. Nothing you configured has been deleted — choosing a plan below restores it.',
      };

    case 'EXPIRED':
      return {
        tone: 'warning',
        title: 'Your plan has expired',
        body: 'Free plan limits apply until you choose a plan.',
      };

    case 'PENDING':
      return {
        tone: 'info',
        title: 'Waiting for Shopify to confirm your plan',
        body: 'This usually takes a few seconds. Use “Refresh” if it does not update.',
      };

    default:
      return null;
  }
}

export function BillingPage() {
  const { data, isPending } = useBilling();
  const openPricing = useOpenPricingPage();
  const refresh = useRefreshSubscription();
  const [selected, setSelected] = useState<Plan | null>(null);

  const subscription = data?.subscription;
  const banner = subscription
    ? statusBanner(subscription.status, subscription.planName, subscription.trialDaysRemaining)
    : null;

  const overLimit = data?.usage.filter((entry) => entry.exceeded) ?? [];
  const nearLimit = data?.usage.filter((entry) => entry.nearLimit && !entry.exceeded) ?? [];

  return (
    <Page
      title="Plan and usage"
      subtitle={data ? `Billing period ${data.periodStart} to ${data.periodEnd}` : undefined}
      titleMetadata={
        subscription ? (
          <InlineStack gap="200">
            <Badge tone={subscription.status === 'ACTIVE' || subscription.status === 'TRIALING' ? 'success' : 'attention'}>
              {subscription.planName}
            </Badge>
            {subscription.isTest ? <Badge tone="info">Test charge</Badge> : null}
          </InlineStack>
        ) : undefined
      }
      secondaryActions={[
        {
          content: 'Refresh',
          onAction: () => refresh.mutate(),
          loading: refresh.isPending,
          // The merchant returning from Shopify's pricing page is the case this
          // exists for — the webhook is reliable but not instant.
          helpText: 'Re-check your plan with Shopify',
        },
      ]}
    >
      <BlockStack gap="400">
        {banner ? (
          <Banner tone={banner.tone} title={banner.title}>
            <p>{banner.body}</p>
          </Banner>
        ) : null}

        {overLimit.length > 0 ? (
          <Banner
            tone="critical"
            title="You have reached a monthly limit"
            action={{ content: 'See plans', onAction: () => openPricing.mutate(undefined) }}
          >
            <p>
              {overLimit.map((entry) => entry.label).join(', ')} — new ones are being refused until you
              upgrade or the period resets on {data?.periodEnd}.
            </p>
          </Banner>
        ) : nearLimit.length > 0 ? (
          <Banner tone="warning" title="You are close to a monthly limit">
            <p>
              {nearLimit.map((entry) => `${entry.label} (${entry.percentUsed}%)`).join(', ')}. Upgrading
              now avoids orders being turned away.
            </p>
          </Banner>
        ) : null}

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <Text as="h2" variant="headingMd">
                  This month
                </Text>

                {isPending ? (
                  <SkeletonBodyText lines={8} />
                ) : (
                  <BlockStack gap="500">
                    {data?.usage.map((entry) => <UsageMeter key={entry.metric} usage={entry} />)}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Your subscription
                </Text>

                {isPending || !subscription ? (
                  <SkeletonBodyText lines={4} />
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {subscription.currentPeriodEnd
                        ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                        : 'No renewal date — you are on the free plan'}
                    </Text>

                    {/*
                      Surfaced rather than hidden. A plan decision made from a
                      cache nobody has confirmed could be wrong in either
                      direction, and the merchant is better served knowing when
                      it was last checked than trusting a number silently.
                    */}
                    <Text as="p" variant="bodySm" tone="subdued">
                      {subscription.lastVerifiedAt
                        ? `Last confirmed with Shopify ${new Date(
                            subscription.lastVerifiedAt,
                          ).toLocaleString()}`
                        : 'Not yet confirmed with Shopify'}
                    </Text>

                    <Text as="p" variant="bodySm" tone="subdued">
                      Payments, invoices and cancellation are handled by Shopify in your admin under
                      Settings → Billing.
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Plans
          </Text>

          <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
            {data?.catalogue.map((definition) => (
              <PlanCard
                key={definition.plan}
                definition={definition}
                currentPlan={subscription?.plan ?? 'FREE'}
                busy={openPricing.isPending && selected === definition.plan}
                onSelect={(plan) => {
                  setSelected(plan);
                  openPricing.mutate(plan);
                }}
              />
            ))}
          </InlineGrid>

          <Text as="p" variant="bodySm" tone="subdued">
            Prices are shown in US dollars. Shopify bills in your store’s currency and handles the
            conversion, the trial and any proration when you change plan.
          </Text>
        </BlockStack>
      </BlockStack>
    </Page>
  );
}

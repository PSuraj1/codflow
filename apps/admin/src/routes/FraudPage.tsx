import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  ResourceItem,
  ResourceList,
  SkeletonBodyText,
  Tabs,
  Text,
} from '@shopify/polaris';
import {
  useDeleteRule,
  useFraudRules,
  useFraudSettings,
  useToggleRule,
} from '../hooks/useFraud';
import { FraudSettingsPanel } from '../components/fraud/FraudSettingsPanel';
import { BlockListPanel } from '../components/fraud/BlockListPanel';
import { BulkListsPanel } from '../components/fraud/BulkListsPanel';
import { DeliveryAreaPanel } from '../components/fraud/DeliveryAreaPanel';
import { SectionTabs, SETTINGS_TABS } from '../components/SectionTabs';

/**
 * Fraud protection.
 *
 * Three tabs rather than one long page: settings are configured once and rarely
 * revisited, while the block list is worked with constantly. Putting them on
 * the same scroll would bury the part merchants actually use daily.
 */
export function FraudPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);

  const { data: settings, isPending, error } = useFraudSettings();
  const { data: rules } = useFraudRules();
  const toggleRule = useToggleRule();
  const deleteRule = useDeleteRule();

  if (isPending) {
    return (
      <Page title="Fraud protection">
        <SectionTabs tabs={SETTINGS_TABS} />
        <Card>
          <SkeletonBodyText lines={10} />
        </Card>
      </Page>
    );
  }

  if (error || !settings) {
    return (
      <Page title="Fraud protection">
        <SectionTabs tabs={SETTINGS_TABS} />
        <Banner tone="critical" title="Could not load your fraud settings">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const tabs = [
    { id: 'settings', content: 'Settings' },
    { id: 'lists', content: 'Block & allow lists' },
    { id: 'rules', content: `Rules${rules?.length ? ` (${rules.length})` : ''}` },
  ];

  return (
    <Page
      title="Fraud protection"
      subtitle="Score every cash-on-delivery order before it reaches Shopify"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
      titleMetadata={
        settings.isEnabled ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Off</Badge>
      }
    >
      <SectionTabs tabs={SETTINGS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Tabs tabs={tabs} selected={tab} onSelect={setTab} fitted />

            {tab === 0 ? <FraudSettingsPanel settings={settings} /> : null}

            {tab === 1 ? (
              <BlockStack gap="400">
                <BulkListsPanel />
                <BlockListPanel />
                <DeliveryAreaPanel />
              </BlockStack>
            ) : null}

            {tab === 2 ? (
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Your rules
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Rules run after the built-in checks and can see the score so far, so you can
                      say things like “anything already above 40 going to this state needs a call”.
                    </Text>
                  </BlockStack>

                  {!rules || rules.length === 0 ? (
                    <EmptyState
                      heading="No rules yet"
                      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                    >
                      <p>
                        The built-in checks cover the common cases. Add a rule when you know
                        something about your own orders that they cannot infer.
                      </p>
                    </EmptyState>
                  ) : (
                    <ResourceList
                      resourceName={{ singular: 'rule', plural: 'rules' }}
                      items={rules}
                      renderItem={(rule) => (
                        <ResourceItem id={rule.id} onClick={() => undefined}>
                          <InlineStack align="space-between" blockAlign="center" wrap={false}>
                            <BlockStack gap="100">
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                  {rule.name}
                                </Text>
                                {rule.isEnabled ? (
                                  <Badge tone="success">On</Badge>
                                ) : (
                                  <Badge>Off</Badge>
                                )}
                                {rule.action ? <Badge tone="attention">{rule.action}</Badge> : null}
                              </InlineStack>

                              <Text as="span" variant="bodySm" tone="subdued">
                                {rule.scoreDelta >= 0 ? `+${rule.scoreDelta}` : rule.scoreDelta} to
                                the score
                                {rule.matchCount > 0
                                  ? ` · matched ${rule.matchCount} time${rule.matchCount === 1 ? '' : 's'}`
                                  : ' · never matched'}
                              </Text>
                            </BlockStack>

                            <InlineStack gap="200">
                              <Button
                                variant="tertiary"
                                loading={toggleRule.isPending}
                                onClick={() =>
                                  toggleRule.mutate({ id: rule.id, isEnabled: !rule.isEnabled })
                                }
                              >
                                {rule.isEnabled ? 'Turn off' : 'Turn on'}
                              </Button>
                              <Button
                                variant="tertiary"
                                tone="critical"
                                loading={deleteRule.isPending}
                                onClick={() => deleteRule.mutate(rule.id)}
                              >
                                Delete
                              </Button>
                            </InlineStack>
                          </InlineStack>
                        </ResourceItem>
                      )}
                    />
                  )}
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

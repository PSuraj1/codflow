import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Banner,
  BlockStack,
  Card,
  Checkbox,
  InlineGrid,
  Layout,
  Page,
  Select,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import type { ShopFeesSummary } from '@codflow/shared';
import { useFees, useUpdateFees } from '../hooks/useFees';
import { useSession } from '../hooks/useSession';
import { SaveBar } from '../components/SaveBar';
import { SectionTabs, SETTINGS_TABS } from '../components/SectionTabs';

/**
 * What COD costs the shopper.
 *
 * The pricing engine has honoured every one of these since it was written, and
 * nothing in the admin could set any of them — a merchant who wanted to change
 * their delivery charge needed someone to run SQL. The seeded 60 and 49 on the
 * test store came from `prisma/seed.ts` for exactly that reason.
 *
 * Worth knowing while editing: none of this is ever trusted from the browser.
 * The submission DTO has no price field, and every amount is re-resolved from
 * these columns server-side, so the form a shopper sees and the order that gets
 * created are priced from the same place.
 */
export function FeesPage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: fees, isPending, error } = useFees();
  const update = useUpdateFees();

  const [draft, setDraft] = useState<ShopFeesSummary | null>(null);

  useEffect(() => {
    if (fees) setDraft(fees);
  }, [fees]);

  if (isPending || !draft) {
    return (
      <Page title="Fees and delivery">
        <Card>
          <SkeletonBodyText lines={8} />
        </Card>
      </Page>
    );
  }

  if (error || !fees) {
    return (
      <Page title="Fees and delivery">
        <Banner tone="critical" title="Could not load your fee settings">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const currency = session?.shop.currencyCode ?? '';
  const dirty = JSON.stringify(draft) !== JSON.stringify(fees);

  const patch = (values: Partial<ShopFeesSummary>) =>
    setDraft((current) => (current ? { ...current, ...values } : current));

  /** Empty is null — "charge nothing" — rather than the string the field holds. */
  const money = (value: string) => (value.trim() === '' ? null : value);

  return (
    <Page
      title="Fees and delivery"
      subtitle="What cash on delivery costs the shopper"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
    >
      <SaveBar
        id="codflow-save-fees"
        dirty={dirty}
        loading={update.isPending}
        message="Unsaved fee changes"
        onSave={() => update.mutate(draft)}
        onDiscard={() => setDraft(fees)}
      />

      <SectionTabs tabs={SETTINGS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Cash on delivery fee
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    A surcharge for paying at the door. Shown as its own line on the form, so a
                    shopper sees it before they order rather than at delivery.
                  </Text>
                </BlockStack>

                <Checkbox
                  label="Charge a cash on delivery fee"
                  checked={draft.codFeeEnabled}
                  onChange={(codFeeEnabled) => patch({ codFeeEnabled })}
                  helpText="Off charges nothing, whatever the amount below says."
                />

                {draft.codFeeEnabled ? (
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <TextField
                      label="Fee"
                      value={draft.codFeeAmount ?? ''}
                      onChange={(value) => patch({ codFeeAmount: money(value) })}
                      autoComplete="off"
                      placeholder="49"
                      prefix={draft.codFeeIsPercent ? undefined : currency}
                      suffix={draft.codFeeIsPercent ? '%' : undefined}
                      helpText={
                        draft.codFeeIsPercent
                          ? 'A percentage of the subtotal, before delivery.'
                          : 'A flat amount added to every COD order.'
                      }
                    />
                    <Select
                      label="Fee type"
                      options={[
                        { label: `Flat amount (${currency})`, value: 'flat' },
                        { label: 'Percentage of subtotal', value: 'percent' },
                      ]}
                      value={draft.codFeeIsPercent ? 'percent' : 'flat'}
                      onChange={(value) => patch({ codFeeIsPercent: value === 'percent' })}
                    />
                  </InlineGrid>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Delivery
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    A flat charge added to every COD order. CODkar does not read your Shopify
                    shipping rates — a COD order never reaches checkout, which is where those are
                    applied — so this is the only delivery charge a shopper is quoted.
                  </Text>
                </BlockStack>

                <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                  <TextField
                    label="Delivery charge"
                    value={draft.shippingFee ?? ''}
                    onChange={(value) => patch({ shippingFee: money(value) })}
                    autoComplete="off"
                    placeholder="60"
                    prefix={currency}
                    helpText="Leave empty to deliver free."
                  />
                  <TextField
                    label="Free delivery above"
                    value={draft.freeShippingAbove ?? ''}
                    onChange={(value) => patch({ freeShippingAbove: money(value) })}
                    autoComplete="off"
                    placeholder="999"
                    prefix={currency}
                    helpText="Compared against the subtotal, so the COD fee cannot push an order over the line and pay for its own delivery. Empty never waives it."
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Banner tone="info" title="Order value limits live under Visibility">
              <p>
                The minimum and maximum order values decide <em>whether</em> COD is offered rather
                than what it costs, so they sit with the rest of the eligibility rules.
              </p>
            </Banner>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

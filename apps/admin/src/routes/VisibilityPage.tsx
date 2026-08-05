import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import { COUNTRIES, type ShopVisibilitySummary } from '@codflow/shared';
import { useVisibility, useUpdateVisibility } from '../hooks/useVisibility';
import { ResourceSelector } from '../components/visibility/ResourceList';
import { SaveBar } from '../components/SaveBar';
import { SectionTabs, SETTINGS_TABS } from '../components/SectionTabs';

/**
 * Where and when COD is offered.
 *
 * Every setting here has been read by the storefront since the form was built
 * and had no screen, so a merchant could not switch COD off, limit it to a few
 * products, or stop offering it to countries they do not ship to.
 *
 * Which *page* the button appears on is deliberately absent — that belongs to
 * each button placement and lives on the COD button screen. Two controls for one
 * behaviour, with no way to tell which wins, is worse than one control in a
 * slightly surprising place.
 */

export function VisibilityPage() {
  const navigate = useNavigate();
  const { data: visibility, isPending, error } = useVisibility();
  const update = useUpdateVisibility();

  const [draft, setDraft] = useState<ShopVisibilitySummary | null>(null);

  useEffect(() => {
    if (visibility) setDraft(visibility);
  }, [visibility]);

  if (isPending || !draft) {
    return (
      <Page title="Visibility">
        <SectionTabs tabs={SETTINGS_TABS} />
        <Card>
          <SkeletonBodyText lines={10} />
        </Card>
      </Page>
    );
  }

  if (error || !visibility) {
    return (
      <Page title="Visibility">
        <SectionTabs tabs={SETTINGS_TABS} />
        <Banner tone="critical" title="Could not load your visibility settings">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(visibility);

  const patch = (values: Partial<ShopVisibilitySummary>) =>
    setDraft((current) => (current ? { ...current, ...values } : current));

  const countryOptions = COUNTRIES.map((country) => ({
    label: country.label,
    value: country.value,
  }));

  return (
    <Page
      title="Visibility"
      subtitle="Where cash on delivery is offered, and to whom"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
      titleMetadata={
        draft.codEnabled ? <Badge tone="success">Live</Badge> : <Badge tone="warning">Off</Badge>
      }
    >
      <SaveBar
        id="codflow-save-visibility"
        dirty={dirty}
        loading={update.isPending}
        message="Unsaved visibility settings"
        onSave={() => update.mutate(draft)}
        onDiscard={() => setDraft(visibility)}
      />

      <SectionTabs tabs={SETTINGS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Cash on delivery
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      The master switch. Off means nothing renders on your storefront at all.
                    </Text>
                  </BlockStack>

                  <Checkbox
                    label="Enabled"
                    checked={draft.codEnabled}
                    onChange={(codEnabled) => patch({ codEnabled })}
                  />
                </InlineStack>

                {!draft.codEnabled ? (
                  <Banner tone="warning">
                    <p>Shoppers see your normal checkout. No COD orders can be placed.</p>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Your theme&rsquo;s own buttons
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Hide these to send every shopper through the COD form.
                  </Text>
                </BlockStack>

                <Checkbox
                  label="Hide Add to cart"
                  checked={draft.replaceAddToCart}
                  onChange={(replaceAddToCart) => patch({ replaceAddToCart })}
                />
                <Checkbox
                  label="Hide Buy it now"
                  checked={draft.replaceBuyNow}
                  onChange={(replaceBuyNow) => patch({ replaceBuyNow })}
                />

                {draft.replaceAddToCart && draft.replaceBuyNow ? (
                  <Banner tone="info">
                    <p>
                      COD is the only way to buy. The theme&rsquo;s buttons are hidden only once a
                      COD button has actually rendered, so a shopper is never left with no way to
                      order.
                    </p>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Which products
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Exclusions always win. A product that is both in an included collection and
                    excluded individually is excluded.
                  </Text>
                </BlockStack>

                <Checkbox
                  label="Offer COD on every product"
                  checked={draft.enabledOnAllProducts}
                  onChange={(enabledOnAllProducts) => patch({ enabledOnAllProducts })}
                />

                {!draft.enabledOnAllProducts ? (
                  <>
                    <ResourceSelector
                      label="Only these products"
                      helpText="Leave empty to rely on collections alone."
                      type="product"
                      value={draft.includedProductGids}
                      onChange={(includedProductGids) => patch({ includedProductGids })}
                    />

                    <ResourceSelector
                      label="Only these collections"
                      helpText="Every product in these collections is offered COD."
                      type="collection"
                      value={draft.includedCollectionGids}
                      onChange={(includedCollectionGids) => patch({ includedCollectionGids })}
                    />

                    {draft.includedProductGids.length === 0 &&
                    draft.includedCollectionGids.length === 0 ? (
                      <Banner tone="warning">
                        <p>
                          Nothing is included, so COD is offered on no product at all. Choose some
                          products or collections, or switch “every product” back on.
                        </p>
                      </Banner>
                    ) : null}
                  </>
                ) : null}

                <Divider />

                <ResourceSelector
                  label="Never these products"
                  helpText="Excluded whatever the rules above say."
                  type="product"
                  value={draft.excludedProductGids}
                  onChange={(excludedProductGids) => patch({ excludedProductGids })}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Which countries
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    An allow list is exclusive — name the countries you ship to and everywhere else
                    is refused. Leave it empty to accept every country except those blocked.
                  </Text>
                </BlockStack>

                <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                  <CountryField
                    label="Only these countries"
                    options={countryOptions}
                    value={draft.allowedCountryCodes}
                    onChange={(allowedCountryCodes) => patch({ allowedCountryCodes })}
                  />
                  <CountryField
                    label="Never these countries"
                    options={countryOptions}
                    value={draft.blockedCountryCodes}
                    onChange={(blockedCountryCodes) => patch({ blockedCountryCodes })}
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Order value
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    COD is refused outside this range. Leave either empty for no bound. Postal-code
                    coverage lives under Fraud protection, with the other lists.
                  </Text>
                </BlockStack>

                <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                  <TextField
                    label="Minimum order value"
                    value={draft.minOrderValue ?? ''}
                    onChange={(value) => patch({ minOrderValue: value === '' ? null : value })}
                    autoComplete="off"
                    placeholder="499"
                    helpText="Below this, COD costs more than it earns."
                  />
                  <TextField
                    label="Maximum order value"
                    value={draft.maxOrderValue ?? ''}
                    onChange={(value) => patch({ maxOrderValue: value === '' ? null : value })}
                    autoComplete="off"
                    placeholder="20000"
                    helpText="The most you are willing to have refused at the door."
                  />
                </InlineGrid>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Countries as a comma-separated list of codes.
 *
 * Polaris has no multi-select, and a two-hundred-row checkbox list is worse than
 * typing `IN, AE`. The names are shown back so a typo is visible — an unknown
 * code is reported rather than silently ignored, because a wrong code in an
 * allow list refuses a whole market.
 */
function CountryField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; value: string }[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const known = new Map(options.map((option) => [option.value, option.label]));
  const unknown = value.filter((code) => !known.has(code));

  return (
    <TextField
      label={label}
      value={value.join(', ')}
      onChange={(text) =>
        onChange(
          text
            .split(',')
            .map((code) => code.trim().toUpperCase())
            .filter((code) => code.length > 0),
        )
      }
      autoComplete="off"
      placeholder="IN, AE"
      error={unknown.length > 0 ? `Not a country code: ${unknown.join(', ')}` : undefined}
      helpText={
        value.length === 0
          ? 'Two-letter codes, comma separated.'
          : value
              .map((code) => known.get(code) ?? code)
              .slice(0, 4)
              .join(', ') + (value.length > 4 ? ` and ${value.length - 4} more` : '')
      }
    />
  );
}

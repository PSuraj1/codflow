import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  RangeSlider,
  Select,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  BRAND_FONT_STACKS,
  LOGO_HEIGHT_MAX,
  LOGO_HEIGHT_MIN,
  PLAN_LIMITS,
  type ShopBrandingSummary,
} from '@codflow/shared';
import { useBranding, useUpdateBranding } from '../hooks/useBranding';
import { useSession } from '../hooks/useSession';
import { ColorField } from '../components/buttons/ColorField';
import { SaveBar } from '../components/SaveBar';
import { FormAppearancePreview } from '../components/branding/FormAppearancePreview';
import { SectionTabs, COD_FORM_TABS } from '../components/SectionTabs';

/**
 * How the COD form looks.
 *
 * The storefront has honoured every one of these values since the form was
 * built, and nothing in the admin could set any of them — so every shop
 * rendered CodFlow's default green regardless of their own brand.
 *
 * Worth knowing while editing: a COD button with its own colours ignores these.
 * `ButtonConfig` carries its own palette and wins, which is what a merchant
 * expects from the more specific setting — but it does mean changing the
 * primary colour here may not change the button they are looking at.
 */
export function AppearancePage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: branding, isPending, error } = useBranding();
  const update = useUpdateBranding();

  const [draft, setDraft] = useState<ShopBrandingSummary | null>(null);

  useEffect(() => {
    if (branding) setDraft(branding);
  }, [branding]);

  if (isPending || !draft) {
    return (
      <Page title="Appearance">
        <Card>
          <SkeletonBodyText lines={10} />
        </Card>
      </Page>
    );
  }

  if (error || !branding) {
    return (
      <Page title="Appearance">
        <Banner tone="critical" title="Could not load your appearance settings">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const customCssAllowed = session ? PLAN_LIMITS[session.subscription.plan].customCss : false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(branding);

  const patch = (values: Partial<ShopBrandingSummary>) =>
    setDraft((current) => (current ? { ...current, ...values } : current));

  return (
    <Page
      title="Appearance"
      subtitle="Colours, type and shape for your COD form"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
    >
      <SaveBar
        id="codflow-save-branding"
        dirty={dirty}
        loading={update.isPending}
        message="Unsaved appearance changes"
        onSave={() => update.mutate(draft)}
        onDiscard={() => setDraft(branding)}
      />

      <SectionTabs tabs={COD_FORM_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Colours
                </Text>

                <InlineStack gap="400" wrap>
                  <ColorField
                    label="Primary"
                    value={draft.primaryColor}
                    onChange={(primaryColor) => patch({ primaryColor })}
                    helpText="Buttons and accents."
                  />
                  <ColorField
                    label="Secondary"
                    value={draft.secondaryColor}
                    onChange={(secondaryColor) => patch({ secondaryColor })}
                    helpText="Hover and pressed states."
                  />
                  <ColorField
                    label="Text"
                    value={draft.textColor}
                    onChange={(textColor) => patch({ textColor })}
                  />
                </InlineStack>

                <Divider />

                <Select
                  label="Colour scheme"
                  options={[
                    { label: "Follow the shopper's device", value: 'SYSTEM' },
                    { label: 'Always light', value: 'LIGHT' },
                    { label: 'Always dark', value: 'DARK' },
                  ]}
                  value={draft.themeMode}
                  onChange={(value) => patch({ themeMode: value as never })}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Type and shape
                </Text>

                <Select
                  label="Font"
                  options={BRAND_FONT_STACKS.map((entry) => ({
                    label: entry.label,
                    value: entry.value,
                  }))}
                  value={
                    BRAND_FONT_STACKS.some((entry) => entry.value === draft.fontFamily)
                      ? draft.fontFamily
                      : 'inherit'
                  }
                  onChange={(fontFamily) => patch({ fontFamily })}
                  helpText="“Match my theme” uses whatever font your storefront already loads, which is almost always the right answer — a font your theme does not serve will not render for shoppers."
                />

                <RangeSlider
                  label="Corner radius"
                  value={draft.borderRadius}
                  min={0}
                  max={40}
                  suffix={<Text as="span">{draft.borderRadius}px</Text>}
                  onChange={(value) => patch({ borderRadius: value as number })}
                />

                <TextField
                  label="Logo URL"
                  value={draft.logoUrl ?? ''}
                  onChange={(value) => patch({ logoUrl: value === '' ? null : value })}
                  autoComplete="off"
                  placeholder="https://cdn.shopify.com/…/logo.png"
                  helpText="Optional, shown at the top of the form. Must be https — upload it to Shopify Files and paste the link."
                />

                {/*
                  Only meaningful once there is a logo. Hiding them rather than
                  disabling them keeps the card from presenting two dead
                  controls to the merchants who never add one.
                */}
                {draft.logoUrl ? (
                  <>
                    <RangeSlider
                      label="Logo height"
                      value={draft.logoHeight}
                      min={LOGO_HEIGHT_MIN}
                      max={LOGO_HEIGHT_MAX}
                      suffix={<Text as="span">{draft.logoHeight}px</Text>}
                      onChange={(value) => patch({ logoHeight: value as number })}
                      helpText="The width follows from your logo’s own proportions."
                    />

                    <Select
                      label="Logo position"
                      options={[
                        { label: 'Left', value: 'left' },
                        { label: 'Centre', value: 'center' },
                        { label: 'Right', value: 'right' },
                      ]}
                      value={draft.logoAlignment}
                      onChange={(value) => patch({ logoAlignment: value as never })}
                    />
                  </>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Custom CSS
                  </Text>
                  {!customCssAllowed ? <Badge tone="attention">Pro</Badge> : null}
                </InlineStack>

                {!customCssAllowed ? (
                  <Banner tone="info">
                    <p>
                      Custom CSS is part of the Pro plan.
                      {draft.customCss
                        ? ' Yours is kept, and starts applying again as soon as you upgrade.'
                        : ''}
                    </p>
                  </Banner>
                ) : null}

                <TextField
                  label="Rules applied to the COD form"
                  labelHidden
                  multiline={5}
                  value={draft.customCss ?? ''}
                  onChange={(value) => patch({ customCss: value === '' ? null : value })}
                  autoComplete="off"
                  disabled={!customCssAllowed}
                  maxLength={10_000}
                  helpText="Targets .codflow-form and its children. Not shown in the preview — check it on your storefront."
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <FormAppearancePreview branding={draft} />

            <Banner tone="info">
              <p>
                A COD button with its own colours keeps them — the button setting is more specific
                and wins. Change those on the COD button screen.
              </p>
            </Banner>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

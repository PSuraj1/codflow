import { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  RangeSlider,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  BUTTON_ANIMATIONS,
  BUTTON_FONT_WEIGHTS,
  FLOATING_POSITIONS,
  INJECTED_BUTTON_PLACEMENTS,
  type ButtonConfigSummary,
  type UpdateButtonConfig,
} from '@codflow/shared';
import { useUpdateButton } from '../../hooks/useButtons';
import { SaveBar } from '../SaveBar';
import { ButtonPreview } from './ButtonPreview';
import { ColorField } from './ColorField';
import { PLACEMENT_COPY } from './placements';

/**
 * One placement's settings, beside a live preview.
 *
 * Only the controls that placement actually honours are rendered. The scroll
 * threshold and the bottom offset belong to the two placements the app injects
 * into the page itself; a product-page button sits inside the theme's own
 * markup and has neither. Showing them everywhere would be four dead knobs on
 * a screen whose entire job is to make the button match what the merchant sees.
 *
 * The draft is local and saved explicitly. Every field here is visible to
 * shoppers the moment it is written, so live-saving each keystroke would
 * publish a half-typed label to a live storefront.
 */

const FONT_WEIGHT_LABELS: Record<(typeof BUTTON_FONT_WEIGHTS)[number], string> = {
  '400': 'Regular',
  '500': 'Medium',
  '600': 'Semibold',
  '700': 'Bold',
};

const ANIMATION_LABELS: Record<(typeof BUTTON_ANIMATIONS)[number], string> = {
  none: 'None',
  pulse: 'Pulse',
  shake: 'Shake',
};

const POSITION_LABELS: Record<(typeof FLOATING_POSITIONS)[number], string> = {
  bottom_right: 'Bottom right',
  bottom_left: 'Bottom left',
};

/** The keys that differ, so a save sends what changed and nothing else. */
function diff(draft: ButtonConfigSummary, saved: ButtonConfigSummary): UpdateButtonConfig {
  const changes: Record<string, unknown> = {};

  for (const key of Object.keys(draft) as (keyof ButtonConfigSummary)[]) {
    if (key === 'placement') continue;
    if (draft[key] !== saved[key]) changes[key] = draft[key];
  }

  return changes;
}

interface Props {
  button: ButtonConfigSummary;
  /** False on a plan without custom CSS. The field stays visible but inert. */
  customCssAllowed: boolean;
}

export function ButtonEditor({ button, customCssAllowed }: Props) {
  const update = useUpdateButton();
  const [draft, setDraft] = useState<ButtonConfigSummary>(button);

  // Re-seeds when the save returns the persisted record, and when the merchant
  // switches to another placement's tab.
  useEffect(() => setDraft(button), [button]);

  const changes = diff(draft, button);
  const dirty = Object.keys(changes).length > 0;

  const copy = PLACEMENT_COPY[button.placement];
  const isInjected = (INJECTED_BUTTON_PLACEMENTS as readonly string[]).includes(button.placement);

  const patch = (values: Partial<ButtonConfigSummary>) =>
    setDraft((current) => ({ ...current, ...values }));

  const save = () => update.mutate({ placement: button.placement, ...changes });

  // The server refuses this combination rather than saving a button that can
  // never render, so it is reported here before the merchant hits save.
  const hiddenEverywhere = draft.isEnabled && !draft.showOnMobile && !draft.showOnDesktop;

  return (
    <BlockStack gap="400">
      <SaveBar
        id={`codflow-save-button-${button.placement.toLowerCase()}`}
        dirty={dirty}
        loading={update.isPending}
        disabled={hiddenEverywhere}
        message={`Unsaved changes to your ${copy.title.toLowerCase()} button`}
        onSave={save}
        onDiscard={() => setDraft(button)}
      />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {copy.title}
                      </Text>
                      {draft.isEnabled ? (
                        <Badge tone="success">On</Badge>
                      ) : (
                        <Badge>Off</Badge>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {copy.description}
                    </Text>
                  </BlockStack>

                  <Checkbox
                    label="Show this button"
                    checked={draft.isEnabled}
                    onChange={(isEnabled) => patch({ isEnabled })}
                  />
                </InlineStack>

                {hiddenEverywhere ? (
                  <Banner tone="critical">
                    <p>
                      This button is on but hidden on both mobile and desktop, so it would never
                      appear. Show it on at least one.
                    </p>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h3" variant="headingSm">
                  Wording
                </Text>

                <TextField
                  label="Label"
                  value={draft.label}
                  onChange={(label) => patch({ label })}
                  autoComplete="off"
                  maxLength={60}
                  showCharacterCount
                />

                <TextField
                  label="Second line"
                  value={draft.subLabel ?? ''}
                  onChange={(subLabel) => patch({ subLabel: subLabel === '' ? null : subLabel })}
                  autoComplete="off"
                  maxLength={80}
                  helpText="Optional. Something like “Pay when it arrives”."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h3" variant="headingSm">
                  Appearance
                </Text>

                <InlineStack gap="400" wrap>
                  <ColorField
                    label="Background"
                    value={draft.bgColor}
                    onChange={(bgColor) => patch({ bgColor })}
                  />
                  <ColorField
                    label="Text"
                    value={draft.textColor}
                    onChange={(textColor) => patch({ textColor })}
                  />
                  <ColorField
                    label="Border"
                    value={draft.borderColor}
                    onChange={(borderColor) => patch({ borderColor })}
                  />
                </InlineStack>

                <Divider />

                <RangeSlider
                  label="Corner radius"
                  value={draft.borderRadius}
                  min={0}
                  max={60}
                  suffix={<Text as="span">{draft.borderRadius}px</Text>}
                  onChange={(value) => patch({ borderRadius: value as number })}
                />

                <RangeSlider
                  label="Text size"
                  value={draft.fontSize}
                  min={10}
                  max={32}
                  suffix={<Text as="span">{draft.fontSize}px</Text>}
                  onChange={(value) => patch({ fontSize: value as number })}
                />

                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <Select
                      label="Text weight"
                      options={BUTTON_FONT_WEIGHTS.map((weight) => ({
                        label: FONT_WEIGHT_LABELS[weight],
                        value: weight,
                      }))}
                      value={draft.fontWeight}
                      onChange={(value) => patch({ fontWeight: value as never })}
                    />
                  </Box>

                  <Box minWidth="200px">
                    <Select
                      label="Animation"
                      options={BUTTON_ANIMATIONS.map((animation) => ({
                        label: ANIMATION_LABELS[animation],
                        value: animation,
                      }))}
                      value={draft.animation}
                      onChange={(value) => patch({ animation: value as never })}
                      helpText="Shoppers who ask their device to reduce motion never see it."
                    />
                  </Box>
                </InlineStack>

                <Divider />

                <InlineStack gap="400" wrap>
                  <Box minWidth="200px">
                    <TextField
                      label="Vertical padding"
                      type="number"
                      suffix="px"
                      value={String(draft.paddingY)}
                      onChange={(value) => patch({ paddingY: Number(value) || 0 })}
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="200px">
                    <TextField
                      label="Horizontal padding"
                      type="number"
                      suffix="px"
                      value={String(draft.paddingX)}
                      onChange={(value) => patch({ paddingX: Number(value) || 0 })}
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>

                <Checkbox
                  label="Stretch to the full width of its container"
                  checked={draft.fullWidth}
                  onChange={(fullWidth) => patch({ fullWidth })}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h3" variant="headingSm">
                  Where it shows
                </Text>

                <Checkbox
                  label="On mobile"
                  checked={draft.showOnMobile}
                  onChange={(showOnMobile) => patch({ showOnMobile })}
                />
                <Checkbox
                  label="On desktop"
                  checked={draft.showOnDesktop}
                  onChange={(showOnDesktop) => patch({ showOnDesktop })}
                />

                {isInjected ? (
                  <>
                    <Divider />

                    <TextField
                      label="Appear after the shopper scrolls"
                      type="number"
                      suffix="px"
                      value={String(draft.showAfterScrollPx)}
                      onChange={(value) => patch({ showAfterScrollPx: Number(value) || 0 })}
                      autoComplete="off"
                      helpText="0 shows it straight away."
                    />

                    <TextField
                      label="Distance from the bottom of the screen"
                      type="number"
                      suffix="px"
                      value={String(draft.stickyOffsetBottom)}
                      onChange={(value) => patch({ stickyOffsetBottom: Number(value) || 0 })}
                      autoComplete="off"
                      helpText="Raise this if your theme already has something pinned down there."
                    />
                  </>
                ) : null}

                {button.placement === 'FLOATING' ? (
                  <Box minWidth="200px">
                    <Select
                      label="Corner"
                      options={FLOATING_POSITIONS.map((position) => ({
                        label: POSITION_LABELS[position],
                        value: position,
                      }))}
                      value={draft.floatingPosition}
                      onChange={(value) => patch({ floatingPosition: value as never })}
                    />
                  </Box>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingSm">
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
                  label="Rules applied to this button on your storefront"
                  labelHidden
                  multiline={4}
                  value={draft.customCss ?? ''}
                  onChange={(customCss) => patch({ customCss: customCss === '' ? null : customCss })}
                  autoComplete="off"
                  disabled={!customCssAllowed}
                  maxLength={5_000}
                  helpText="Targets .codflow-button. Not shown in the preview — check it on your store."
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <ButtonPreview button={draft} customCssActive={customCssAllowed} />
        </Layout.Section>
      </Layout>
    </BlockStack>
  );
}

import { useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import {
  SERVER_SIDE_EVENTS,
  type PixelEventName,
  type PixelProvider,
  type PixelSummary,
} from '@codflow/shared';
import { ApiError } from '../../lib/apiClient';
import { useCreatePixel, useUpdatePixel, type PixelInput } from '../../hooks/usePixels';
import { EVENT_LABELS, PROVIDER_CATALOGUE, PROVIDER_ORDER, eventsFor } from './providerCatalogue';

/**
 * Add or edit one pixel.
 *
 * A modal rather than a page because the decision is small and the surrounding
 * list is the context — a merchant adding a second pixel wants to see the first
 * one behind it.
 *
 * The access token is the delicate part. It is write-only: the server returns
 * only `hasAccessToken`, so the field starts blank on an edit and an untouched
 * blank means "leave it alone" rather than "clear it". Clearing is a separate,
 * explicit action, because a merchant who tabbed through the form should not
 * silently lose the credential that makes server-side tracking work.
 */

interface Props {
  /** The pixel being edited, or null when adding. */
  pixel: PixelSummary | null;
  open: boolean;
  onClose: () => void;
}

interface Draft {
  provider: PixelProvider;
  label: string;
  pixelId: string;
  isEnabled: boolean;
  clientSideEnabled: boolean;
  serverSideEnabled: boolean;
  accessToken: string;
  clearToken: boolean;
  testEventCode: string;
  conversionId: string;
  conversionLabel: string;
  gtmContainerId: string;
  advancedMatching: boolean;
  deduplication: boolean;
  requireConsent: boolean;
  enabledEvents: PixelEventName[];
  customScript: string;
}

function draftFrom(pixel: PixelSummary | null): Draft {
  return {
    provider: pixel?.provider ?? 'META',
    label: pixel?.label ?? '',
    pixelId: pixel?.pixelId ?? '',
    isEnabled: pixel?.isEnabled ?? true,
    clientSideEnabled: pixel?.clientSideEnabled ?? true,
    serverSideEnabled: pixel?.serverSideEnabled ?? false,
    accessToken: '',
    clearToken: false,
    testEventCode: pixel?.testEventCode ?? '',
    conversionId: pixel?.conversionId ?? '',
    conversionLabel: pixel?.conversionLabel ?? '',
    gtmContainerId: pixel?.gtmContainerId ?? '',
    advancedMatching: pixel?.advancedMatching ?? true,
    deduplication: pixel?.deduplication ?? true,
    requireConsent: pixel?.requireConsent ?? true,
    enabledEvents: [...(pixel?.enabledEvents ?? [])],
    customScript: '',
  };
}

export function PixelForm({ pixel, open, onClose }: Props) {
  const create = useCreatePixel();
  const update = useUpdatePixel();

  const [draft, setDraft] = useState<Draft>(() => draftFrom(pixel));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const copy = PROVIDER_CATALOGUE[draft.provider];
  const available = eventsFor(draft.provider);
  const isEdit = pixel !== null;
  const saving = create.isPending || update.isPending;

  const patch = (values: Partial<Draft>) => setDraft((current) => ({ ...current, ...values }));

  // The server refuses this combination, and the refusal arrives after a save
  // the merchant thought would work. Saying so up front is cheaper.
  const tokenMissing =
    draft.serverSideEnabled &&
    copy.needsAccessToken &&
    draft.accessToken.trim() === '' &&
    (draft.clearToken || !pixel?.hasAccessToken);

  const nothingEnabled = !draft.clientSideEnabled && !draft.serverSideEnabled;

  function toggleEvent(event: PixelEventName, checked: boolean) {
    patch({
      enabledEvents: checked
        ? [...draft.enabledEvents, event]
        : draft.enabledEvents.filter((entry) => entry !== event),
    });
  }

  async function submit() {
    setFieldErrors({});

    const payload: PixelInput = {
      provider: draft.provider,
      label: draft.label.trim(),
      pixelId: draft.pixelId.trim(),
      isEnabled: draft.isEnabled,
      clientSideEnabled: draft.clientSideEnabled,
      serverSideEnabled: draft.serverSideEnabled,
      advancedMatching: draft.advancedMatching,
      deduplication: draft.deduplication,
      requireConsent: draft.requireConsent,
      enabledEvents: draft.enabledEvents,
      testEventCode: draft.testEventCode.trim() || null,
      conversionId: draft.conversionId.trim() || null,
      conversionLabel: draft.conversionLabel.trim() || null,
      gtmContainerId: draft.gtmContainerId.trim() || null,
      customScript: draft.customScript.trim() || null,
      // Three states, not two: a typed value sets it, an explicit clear removes
      // it, and absence leaves whatever is stored untouched.
      ...(draft.accessToken.trim() !== ''
        ? { accessToken: draft.accessToken.trim() }
        : draft.clearToken
          ? { accessToken: null }
          : {}),
    };

    try {
      if (isEdit) {
        await update.mutateAsync({ id: pixel.id, ...payload });
      } else {
        await create.mutateAsync(payload);
      }
      onClose();
    } catch (error) {
      // The toast already carries the message; this binds it to the field that
      // caused it, which is what tells a merchant their pixel id is the problem.
      if (error instanceof ApiError && error.fieldErrors) {
        setFieldErrors(error.fieldErrors);
      }
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit ${pixel.label}` : 'Add an ad pixel'}
      primaryAction={{
        content: isEdit ? 'Save' : 'Add pixel',
        onAction: () => void submit(),
        loading: saving,
        disabled: draft.label.trim() === '' || draft.pixelId.trim() === '' || nothingEnabled,
      }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Select
            label="Ad platform"
            options={PROVIDER_ORDER.map((provider) => ({
              label: PROVIDER_CATALOGUE[provider].name,
              value: provider,
            }))}
            value={draft.provider}
            // Locked after creation: the identifier format is validated per
            // provider only on create, so switching here would leave a pixel
            // whose id belongs to a different platform — the exact mistake the
            // per-provider validation exists to catch.
            disabled={isEdit}
            helpText={isEdit ? 'Add a new pixel to track a different platform.' : undefined}
            onChange={(value) =>
              patch({
                provider: value as PixelProvider,
                // Carrying events across platforms would enable ones the new
                // provider cannot receive.
                enabledEvents: [],
              })
            }
          />

          <TextField
            label="Name"
            value={draft.label}
            onChange={(label) => patch({ label })}
            autoComplete="off"
            placeholder={copy.namePlaceholder}
            helpText="Only for your reference."
            error={fieldErrors.label?.[0]}
          />

          <TextField
            label={copy.idLabel}
            value={draft.pixelId}
            onChange={(pixelId) => patch({ pixelId })}
            autoComplete="off"
            placeholder={copy.idPlaceholder}
            helpText={`${copy.idHelp} Find it in ${copy.whereToFind}.`}
            error={fieldErrors.pixelId?.[0]}
          />

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              How events are sent
            </Text>

            <Checkbox
              label="From the shopper's browser"
              checked={draft.clientSideEnabled}
              onChange={(clientSideEnabled) => patch({ clientSideEnabled })}
              helpText="Covers browsing and cart activity. Blocked for some shoppers by ad blockers."
            />

            <Checkbox
              label="From CODkar's server"
              checked={draft.serverSideEnabled}
              onChange={(serverSideEnabled) => patch({ serverSideEnabled })}
              helpText={`Not affected by ad blockers, and the only way a COD order is reported at all — the shopper has usually closed the tab by then. Covers ${SERVER_SIDE_EVENTS.map((event) => EVENT_LABELS[event].toLowerCase()).join(', ')}.`}
            />

            {nothingEnabled ? (
              <Banner tone="critical">
                <p>With both switched off this pixel would never send anything.</p>
              </Banner>
            ) : null}
          </BlockStack>

          {/*
            Shown whenever the provider has a Conversions API, not only once
            server-side sending is ticked. Hiding it behind that checkbox made
            it undiscoverable: a merchant who came here to paste a CAPI token
            found no field for it and no hint that one existed.
          */}
          {copy.needsAccessToken ? (
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingSm">
                  Conversions API token
                </Text>
                {pixel?.hasAccessToken && !draft.clearToken ? (
                  <Badge tone="success">Stored</Badge>
                ) : null}
              </InlineStack>

              <TextField
                label="Access token"
                labelHidden
                type="password"
                value={draft.accessToken}
                onChange={(accessToken) => patch({ accessToken, clearToken: false })}
                autoComplete="off"
                placeholder={
                  pixel?.hasAccessToken && !draft.clearToken
                    ? 'Leave blank to keep the stored token'
                    : 'Paste the token'
                }
                error={fieldErrors.accessToken?.[0]}
                helpText={
                  draft.serverSideEnabled
                    ? "Stored encrypted. It is never sent to a shopper's browser and never shown again here."
                    : `Needed to send events from CODkar's server — tick that above to use it. Stored encrypted, and never sent to a shopper's browser.`
                }
              />

              {pixel?.hasAccessToken ? (
                <InlineStack>
                  <Button
                    variant="plain"
                    tone={draft.clearToken ? undefined : 'critical'}
                    onClick={() => patch({ clearToken: !draft.clearToken, accessToken: '' })}
                  >
                    {draft.clearToken ? 'Keep the stored token' : 'Remove the stored token'}
                  </Button>
                </InlineStack>
              ) : null}

              {tokenMissing ? (
                <Banner tone="warning">
                  <p>
                    Server-side tracking needs a token. Add one, or switch server-side off — the
                    save will be refused otherwise.
                  </p>
                </Banner>
              ) : null}
            </BlockStack>
          ) : null}

          {copy.needsConversionFields ? (
            <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
              <TextField
                label="Conversion ID"
                value={draft.conversionId}
                onChange={(conversionId) => patch({ conversionId })}
                autoComplete="off"
                error={fieldErrors.conversionId?.[0]}
              />
              <TextField
                label="Conversion label"
                value={draft.conversionLabel}
                onChange={(conversionLabel) => patch({ conversionLabel })}
                autoComplete="off"
                helpText="Identifies which conversion action to credit."
                error={fieldErrors.conversionLabel?.[0]}
              />
            </InlineGrid>
          ) : null}

          {copy.supportsTestEventCode ? (
            <TextField
              label="Test event code"
              value={draft.testEventCode}
              onChange={(testEventCode) => patch({ testEventCode })}
              autoComplete="off"
              helpText="Optional. Routes events to the platform's test view instead of live reporting — remove it when you go live."
              error={fieldErrors.testEventCode?.[0]}
            />
          ) : null}

          {copy.supportsCustomScript ? (
            <TextField
              label="Browser script"
              multiline={4}
              value={draft.customScript}
              onChange={(customScript) => patch({ customScript })}
              autoComplete="off"
              helpText="Runs in Shopify's web pixel sandbox. It cannot reach your theme or the page's DOM."
              error={fieldErrors.customScript?.[0]}
            />
          ) : null}

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Which events to send
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Leave every box unticked to send everything {copy.name} accepts.
            </Text>

            <Box paddingBlockStart="100">
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="100">
                {available.map((event) => (
                  <Checkbox
                    key={event}
                    label={EVENT_LABELS[event]}
                    checked={draft.enabledEvents.includes(event)}
                    onChange={(checked) => toggleEvent(event, checked)}
                  />
                ))}
              </InlineGrid>
            </Box>
          </BlockStack>

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              Matching and privacy
            </Text>

            <Checkbox
              label="Improve matching with customer details"
              checked={draft.advancedMatching}
              onChange={(advancedMatching) => patch({ advancedMatching })}
              helpText="Email and phone are hashed on the server before they are sent. The raw values never leave CODkar."
            />

            <Checkbox
              label="Remove duplicate events"
              checked={draft.deduplication}
              onChange={(deduplication) => patch({ deduplication })}
              helpText="The browser and the server send the same order with the same event ID, so the platform counts it once. Turning this off double-counts every sale."
            />

            <Checkbox
              label="Wait for cookie consent"
              checked={draft.requireConsent}
              onChange={(requireConsent) => patch({ requireConsent })}
              helpText="Browser events only fire once the shopper has accepted tracking."
            />
          </BlockStack>

          <Checkbox
            label="This pixel is active"
            checked={draft.isEnabled}
            onChange={(isEnabled) => patch({ isEnabled })}
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

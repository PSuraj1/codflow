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
  RangeSlider,
  Select,
  Text,
  TextField,
} from '@shopify/polaris';
import type { FraudSettingsSummary } from '@codflow/shared';
import { useUpdateFraudSettings } from '../../hooks/useFraud';
import { SaveBar } from '../SaveBar';

/**
 * Fraud configuration.
 *
 * The thresholds are presented as one continuous 0–100 band rather than three
 * independent numbers, because they are only meaningful relative to each other
 * — and a merchant who sets high below medium has inverted their own policy
 * without any obvious symptom. The server enforces the ordering too; this
 * prevents the mistake rather than reporting it.
 */

const ACTIONS = [
  { label: 'Allow the order', value: 'ALLOW' },
  { label: 'Hold for my review', value: 'REVIEW' },
  { label: 'Require phone verification', value: 'CHALLENGE_OTP' },
  { label: 'Block the order', value: 'BLOCK' },
];

interface Props {
  settings: FraudSettingsSummary;
}

export function FraudSettingsPanel({ settings }: Props) {
  const update = useUpdateFraudSettings();
  const [draft, setDraft] = useState<FraudSettingsSummary>(settings);

  // Re-seeds after a save returns the persisted values.
  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  const patch = (changes: Partial<FraudSettingsSummary>) =>
    setDraft((current) => ({ ...current, ...changes }));

  const save = () => {
    const { ipIntelAvailable, ...payload } = draft;
    update.mutate(payload);
  };

  return (
    <BlockStack gap="400">
      <SaveBar
        id="codflow-save-fraud-settings"
        dirty={dirty}
        loading={update.isPending}
        message="Unsaved fraud settings"
        onSave={save}
        onDiscard={() => setDraft(settings)}
      />

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                Fraud protection
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Every order is scored from 0 to 100. Nothing is blocked on one signal alone — it is
                the combination that counts.
              </Text>
            </BlockStack>

            <Checkbox
              label="Enabled"
              checked={draft.isEnabled}
              onChange={(isEnabled) => patch({ isEnabled })}
            />
          </InlineStack>

          {!draft.isEnabled ? (
            <Banner tone="warning">
              <p>Every order is being accepted without a risk check.</p>
            </Banner>
          ) : null}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">
            Thresholds
          </Text>

          <RangeSlider
            label="Medium risk starts at"
            value={draft.mediumThreshold}
            min={1}
            max={99}
            output
            onChange={(value) =>
              patch({
                mediumThreshold: value as number,
                // Kept ordered as the merchant drags, so an invalid combination
                // is impossible rather than merely rejected on save.
                highThreshold: Math.max(draft.highThreshold, (value as number) + 1),
                criticalThreshold: Math.max(draft.criticalThreshold, (value as number) + 2),
              })
            }
          />

          <RangeSlider
            label="High risk starts at"
            value={draft.highThreshold}
            min={draft.mediumThreshold + 1}
            max={99}
            output
            onChange={(value) =>
              patch({
                highThreshold: value as number,
                criticalThreshold: Math.max(draft.criticalThreshold, (value as number) + 1),
              })
            }
          />

          <RangeSlider
            label="Critical risk starts at"
            value={draft.criticalThreshold}
            min={draft.highThreshold + 1}
            max={100}
            output
            onChange={(value) => patch({ criticalThreshold: value as number })}
          />

          <Divider />

          <Text as="h3" variant="headingSm">
            What to do at each level
          </Text>

          <InlineStack gap="300" wrap>
            <Box minWidth="200px">
              <Select
                label="Medium"
                options={ACTIONS}
                value={draft.actionOnMedium}
                onChange={(value) => patch({ actionOnMedium: value as never })}
              />
            </Box>
            <Box minWidth="200px">
              <Select
                label="High"
                options={ACTIONS}
                value={draft.actionOnHigh}
                onChange={(value) => patch({ actionOnHigh: value as never })}
              />
            </Box>
            <Box minWidth="200px">
              <Select
                label="Critical"
                options={ACTIONS}
                value={draft.actionOnCritical}
                onChange={(value) => patch({ actionOnCritical: value as never })}
              />
            </Box>
          </InlineStack>

          <Text as="p" variant="bodySm" tone="subdued">
            “Hold for my review” still creates the order and tells the customer it worked — it just
            waits for you before going to Shopify.
          </Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Checks
          </Text>

          <Checkbox
            label="Repeat orders from the same phone"
            checked={draft.checkDuplicatePhone}
            onChange={(value) => patch({ checkDuplicatePhone: value })}
          />
          <Checkbox
            label="Repeat orders from the same email"
            checked={draft.checkDuplicateEmail}
            onChange={(value) => patch({ checkDuplicateEmail: value })}
          />
          <Checkbox
            label="Repeat orders to the same address"
            checked={draft.checkDuplicateAddress}
            onChange={(value) => patch({ checkDuplicateAddress: value })}
          />
          <Checkbox
            label="Throwaway email addresses"
            checked={draft.checkDisposableEmail}
            onChange={(value) => patch({ checkDisposableEmail: value })}
          />
          <Checkbox
            label="Made-up phone numbers"
            checked={draft.checkFakePhone}
            onChange={(value) => patch({ checkFakePhone: value })}
          />
          <Checkbox
            label="Order bursts and daily limits"
            checked={draft.checkVelocity}
            onChange={(value) => patch({ checkVelocity: value })}
          />
          <Checkbox
            label="Your block and allow lists"
            checked={draft.checkBlockList}
            onChange={(value) => patch({ checkBlockList: value })}
          />

          <Checkbox
            label="Count orders per browser as well"
            checked={draft.checkDeviceVelocity}
            onChange={(value) => patch({ checkDeviceVelocity: value })}
            helpText="Catches someone cycling phone numbers from one machine. Off by default — a shared family device placing two orders is ordinary."
          />

          {draft.checkDeviceVelocity ? (
            <Box paddingInlineStart="600" maxWidth="260px">
              <TextField
                label="Orders per day, per browser"
                type="number"
                value={String(draft.maxOrdersPerDayPerDevice)}
                onChange={(value) => patch({ maxOrdersPerDayPerDevice: Number(value) || 1 })}
                autoComplete="off"
              />
            </Box>
          ) : null}

          <Divider />

          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Network checks
            </Text>
            {!draft.ipIntelAvailable ? <Badge tone="attention">Not configured</Badge> : null}
          </InlineStack>

          {!draft.ipIntelAvailable ? (
            // Offering toggles that silently do nothing is worse than
            // explaining why they are unavailable.
            <Banner tone="info">
              <p>
                These need an IP intelligence provider, which is set up by whoever hosts this app.
                Until then they have no effect.
              </p>
            </Banner>
          ) : null}

          <Checkbox
            label="Orders placed over Tor"
            checked={draft.checkTor}
            disabled={!draft.ipIntelAvailable}
            onChange={(value) => patch({ checkTor: value })}
          />
          <Checkbox
            label="Orders placed over a VPN"
            checked={draft.checkVpn}
            disabled={!draft.ipIntelAvailable}
            onChange={(value) => patch({ checkVpn: value })}
          />
          <Checkbox
            label="Orders placed over a proxy or from a datacentre"
            checked={draft.checkProxy}
            disabled={!draft.ipIntelAvailable}
            onChange={(value) => patch({ checkProxy: value })}
          />
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">
            Limits
          </Text>

          <InlineStack gap="300" wrap>
            <Box minWidth="220px">
              <TextField
                label="Orders per day, per phone"
                type="number"
                value={String(draft.maxOrdersPerDayPerPhone)}
                onChange={(value) => patch({ maxOrdersPerDayPerPhone: Number(value) || 1 })}
                autoComplete="off"
              />
            </Box>
            <Box minWidth="220px">
              <TextField
                label="Orders per day, per network"
                type="number"
                value={String(draft.maxOrdersPerDayPerIp)}
                onChange={(value) => patch({ maxOrdersPerDayPerIp: Number(value) || 1 })}
                autoComplete="off"
              />
            </Box>
            <Box minWidth="220px">
              <TextField
                label="Undelivered COD orders allowed"
                type="number"
                value={String(draft.maxOpenCodOrders)}
                onChange={(value) => patch({ maxOpenCodOrders: Number(value) || 1 })}
                autoComplete="off"
                helpText="Parcels already out for delivery and unpaid."
              />
            </Box>
            <Box minWidth="220px">
              <TextField
                label="Burst window (minutes)"
                type="number"
                value={String(draft.velocityWindowMinutes)}
                onChange={(value) => patch({ velocityWindowMinutes: Number(value) || 1 })}
                autoComplete="off"
              />
            </Box>
          </InlineStack>

          <Divider />

          <TextField
            label="Block a customer automatically after this many failed deliveries"
            type="number"
            value={String(draft.autoBlacklistAfterFailures)}
            onChange={(value) => patch({ autoBlacklistAfterFailures: Number(value) || 0 })}
            autoComplete="off"
            helpText="0 turns this off, which is the default. A customer whose parcels were lost by the courier looks the same as one who refused them, so this is worth setting high."
          />

          <Divider />

          <TextField
            label="Flag an order with more than this many items"
            type="number"
            value={String(draft.maxItemsPerOrder)}
            onChange={(value) => patch({ maxItemsPerOrder: Number(value) || 0 })}
            autoComplete="off"
            helpText="Counts every unit, not every line. 0 turns it off — there is no sensible default, because a wholesaler's normal order is a warning sign for a boutique."
          />

          <Divider />

          <TextField
            label="What a refused customer is told"
            value={draft.blockedMessage ?? ''}
            onChange={(value) => patch({ blockedMessage: value === '' ? null : value })}
            autoComplete="off"
            multiline={2}
            maxLength={300}
            placeholder="We are unable to accept this order."
            helpText="Leave empty for the standard wording. The reason is never included, deliberately — telling someone which detail tripped the check tells them what to change."
          />
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

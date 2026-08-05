import { useCallback, useState } from 'react';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Modal,
  ResourceItem,
  ResourceList,
  Select,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import { useAddBlockListEntry, useBlockList, useRemoveBlockListEntry } from '../../hooks/useFraud';

/**
 * Block and allow lists.
 *
 * Both live in one panel because they are the same mechanism with opposite
 * signs, and merchants think of them together — "never accept this number,
 * always accept that one". Separating them into two screens would make the
 * relationship invisible.
 */

const SCOPES = [
  { label: 'Phone number', value: 'PHONE' },
  { label: 'Email address', value: 'EMAIL' },
  { label: 'IP address', value: 'IP' },
  { label: 'PIN / postal code', value: 'POSTAL_CODE' },
  { label: 'Country', value: 'COUNTRY' },
  { label: 'Device', value: 'DEVICE_FINGERPRINT' },
];

const PLACEHOLDER: Record<string, string> = {
  PHONE: '+91 98765 43210',
  EMAIL: 'someone@example.com',
  IP: '203.0.113.7',
  POSTAL_CODE: '411001',
  COUNTRY: 'IN',
  DEVICE_FINGERPRINT: 'device id from an order',
};

export function BlockListPanel() {
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const [entryType, setEntryType] = useState('BLACKLIST');
  const [scope, setScope] = useState('PHONE');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  const { data: entries, isPending } = useBlockList({
    ...(typeFilter ? { type: typeFilter } : {}),
    ...(search ? { search } : {}),
  });

  const addEntry = useAddBlockListEntry();
  const removeEntry = useRemoveBlockListEntry();

  const submit = useCallback(() => {
    addEntry.mutate(
      {
        type: entryType,
        scope,
        value: value.trim(),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      {
        onSuccess: () => {
          setAddOpen(false);
          setValue('');
          setReason('');
        },
      },
    );
  }, [addEntry, entryType, scope, value, reason]);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Block and allow lists
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              A blocked entry stops the order outright. An allowed entry clears it however it
              scores — useful for a regular customer the checks keep flagging.
            </Text>
          </BlockStack>

          <Button variant="primary" onClick={() => setAddOpen(true)}>
            Add entry
          </Button>
        </InlineStack>

        <InlineStack gap="300">
          <Select
            label="Type"
            labelInline
            options={[
              { label: 'All', value: '' },
              { label: 'Blocked', value: 'BLACKLIST' },
              { label: 'Allowed', value: 'WHITELIST' },
            ]}
            value={typeFilter}
            onChange={setTypeFilter}
          />
          <TextField
            label="Search"
            labelHidden
            placeholder="Search by value"
            value={search}
            onChange={setSearch}
            autoComplete="off"
            clearButton
            onClearButtonClick={() => setSearch('')}
          />
        </InlineStack>

        {isPending ? (
          <SkeletonBodyText lines={4} />
        ) : !entries || entries.length === 0 ? (
          <EmptyState
            heading="No entries yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              Block a phone number or address you never want to accept again, or allow one your
              checks keep flagging by mistake.
            </p>
          </EmptyState>
        ) : (
          <ResourceList
            resourceName={{ singular: 'entry', plural: 'entries' }}
            items={entries}
            renderItem={(entry) => (
              <ResourceItem id={entry.id} onClick={() => undefined}>
                <InlineStack align="space-between" blockAlign="center" wrap={false}>
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {entry.value}
                      </Text>
                      <Badge tone={entry.type === 'BLACKLIST' ? 'critical' : 'success'}>
                        {entry.type === 'BLACKLIST' ? 'Blocked' : 'Allowed'}
                      </Badge>
                      <Badge>{entry.scope.replace(/_/g, ' ').toLowerCase()}</Badge>
                      {entry.createdBy === 'system' ? <Badge tone="info">Automatic</Badge> : null}
                    </InlineStack>

                    <Text as="span" variant="bodySm" tone="subdued">
                      {entry.reason ?? 'No reason given'}
                      {/* The hit count is how a merchant tells a rule that is
                          working from one they configured wrong. */}
                      {entry.hitCount > 0 ? ` · matched ${entry.hitCount} time${entry.hitCount === 1 ? '' : 's'}` : ' · never matched'}
                    </Text>
                  </BlockStack>

                  <Button
                    variant="tertiary"
                    tone="critical"
                    loading={removeEntry.isPending}
                    onClick={() => removeEntry.mutate(entry.id)}
                  >
                    Remove
                  </Button>
                </InlineStack>
              </ResourceItem>
            )}
          />
        )}
      </BlockStack>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add to your lists"
        primaryAction={{
          content: 'Add',
          onAction: submit,
          disabled: value.trim().length === 0,
          loading: addEntry.isPending,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setAddOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Select
              label="Action"
              options={[
                { label: 'Block — never accept this', value: 'BLACKLIST' },
                { label: 'Allow — always accept this', value: 'WHITELIST' },
              ]}
              value={entryType}
              onChange={setEntryType}
            />

            <Select label="Match on" options={SCOPES} value={scope} onChange={setScope} />

            <TextField
              label="Value"
              value={value}
              onChange={setValue}
              autoComplete="off"
              placeholder={PLACEHOLDER[scope]}
              helpText={
                scope === 'PHONE'
                  ? 'Any format works — it is stored in international form so it matches however the customer types it.'
                  : undefined
              }
            />

            <TextField
              label="Reason"
              value={reason}
              onChange={setReason}
              autoComplete="off"
              multiline={2}
              helpText="Only you see this. Worth writing — you will not remember in six months."
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Card>
  );
}

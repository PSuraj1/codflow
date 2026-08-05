import { useEffect, useMemo, useState } from 'react';
import {
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Text,
  TextField,
} from '@shopify/polaris';
import type { BlockListEntrySummary } from '@codflow/shared';
import { useBlockList, useReplaceBlockList } from '../../hooks/useFraud';

/**
 * The block and allow lists, edited as lists.
 *
 * The per-entry panel below this one is better for investigating — it shows how
 * often each entry has matched, who added it and when it expires. This is for
 * the other half of the job: pasting a column out of a spreadsheet, or deleting
 * forty lines at once. Both edit the same rows.
 *
 * Each box is one `(type, scope)` pair and is saved wholesale, so removing a
 * line removes the entry. Values are normalized server-side before comparison —
 * a merchant re-pasting `+91 98765 43210` over a stored `+919876543210` has
 * changed nothing and will be told so, rather than churning the row and losing
 * its match history.
 */

interface ListSpec {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly placeholder: string;
  readonly type: 'BLACKLIST' | 'WHITELIST';
  readonly scope: string;
}

const LISTS: readonly ListSpec[] = [
  {
    key: 'phone',
    label: 'Phone numbers to block',
    help: 'One per line, with the country code.',
    placeholder: '+919876543210\n+919812345678',
    type: 'BLACKLIST',
    scope: 'PHONE',
  },
  {
    key: 'email',
    label: 'Email addresses to block',
    help: 'One per line.',
    placeholder: 'someone@example.com',
    type: 'BLACKLIST',
    scope: 'EMAIL',
  },
  {
    key: 'ip-block',
    label: 'Blocked IP addresses',
    help: 'One per line.',
    placeholder: '203.0.113.4',
    type: 'BLACKLIST',
    scope: 'IP',
  },
  {
    key: 'ip-allow',
    label: 'Allowed IP addresses',
    // Worth stating plainly: an allow entry beats every other signal, which is
    // exactly what a merchant wants for their own office and exactly what they
    // do not want for anything else.
    help: 'Always accepted, whatever the risk score says. Use it for your own network.',
    placeholder: '203.0.113.4',
    type: 'WHITELIST',
    scope: 'IP',
  },
];

/** Newline-separated text out of stored entries, and back again. */
function toText(entries: readonly BlockListEntrySummary[], spec: ListSpec): string {
  return entries
    .filter((entry) => entry.type === spec.type && entry.scope === spec.scope)
    .map((entry) => entry.value)
    .join('\n');
}

function toValues(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function BulkListsPanel() {
  const { data: entries } = useBlockList({});
  const replace = useReplaceBlockList();

  const saved = useMemo(() => {
    const result: Record<string, string> = {};
    for (const spec of LISTS) result[spec.key] = toText(entries ?? [], spec);
    return result;
  }, [entries]);

  const [drafts, setDrafts] = useState<Record<string, string>>(saved);

  // Re-seeds once the lists load, and after a save returns the stored values —
  // which is how a merchant sees their pasted text normalized in place.
  useEffect(() => setDrafts(saved), [saved]);

  const changed = LISTS.filter((spec) => (drafts[spec.key] ?? '') !== (saved[spec.key] ?? ''));

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Block and allow lists
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Paste or edit these as lists — one value per line. Saving replaces the whole box, so
            deleting a line removes it.
          </Text>
        </BlockStack>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          {LISTS.map((spec) => {
            const value = drafts[spec.key] ?? '';
            const count = toValues(value).length;

            return (
              <TextField
                key={spec.key}
                label={spec.label}
                multiline={6}
                value={value}
                onChange={(next) => setDrafts((current) => ({ ...current, [spec.key]: next }))}
                autoComplete="off"
                placeholder={spec.placeholder}
                helpText={`${spec.help} ${count} ${count === 1 ? 'entry' : 'entries'}.`}
              />
            );
          })}
        </InlineGrid>

        <InlineStack align="end" gap="200">
          {changed.length > 0 ? (
            <Button onClick={() => setDrafts(saved)} disabled={replace.isPending}>
              Discard
            </Button>
          ) : null}

          <Button
            variant="primary"
            disabled={changed.length === 0}
            loading={replace.isPending}
            onClick={() => {
              // Only the boxes that changed are sent. Re-saving an untouched
              // list would re-run the reconciliation for nothing and re-queue a
              // rescan of every pending order.
              for (const spec of changed) {
                replace.mutate({
                  type: spec.type,
                  scope: spec.scope,
                  values: toValues(drafts[spec.key] ?? ''),
                });
              }
            }}
          >
            {changed.length === 0
              ? 'Saved'
              : `Save ${changed.length} list${changed.length === 1 ? '' : 's'}`}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

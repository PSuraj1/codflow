import { useState } from 'react';
import { Badge, BlockStack, Button, InlineStack, Text, TextField } from '@shopify/polaris';
import { pickResources } from '../../lib/appBridge';

/**
 * A set of products or collections, chosen through Shopify's own picker.
 *
 * The picker is the admin's, not ours: it searches the merchant's whole
 * catalogue, which an app-side control could only match by paginating the Admin
 * API and rebuilding a search box Shopify already ships.
 *
 * The manual fallback exists because the picker is unavailable outside the
 * admin and on older App Bridge builds, and a selector that silently does
 * nothing would leave a merchant unable to configure the thing this screen is
 * about. It takes raw GIDs, which is unpleasant — and correct, because it is
 * what the storefront compares against.
 */

interface Props {
  label: string;
  helpText: string;
  type: 'product' | 'collection';
  value: readonly string[];
  onChange: (next: string[]) => void;
}

/** `gid://shopify/Product/123` → `Product 123`, for a readable summary. */
function describe(gid: string): string {
  const parts = gid.split('/');
  const id = parts[parts.length - 1] ?? gid;
  const kind = parts[parts.length - 2] ?? '';
  return `${kind} ${id}`.trim();
}

export function ResourceSelector({ label, helpText, type, value, onChange }: Props) {
  const [manual, setManual] = useState('');
  const [pickerUnavailable, setPickerUnavailable] = useState(false);

  async function browse() {
    const chosen = await pickResources({ type, selected: value });

    if (chosen === null) {
      // Either cancelled or unavailable. Revealing the manual field on the
      // first attempt is wrong for a cancel, so it only appears once the picker
      // has failed to open at all — which `pickResources` reports as null with
      // no picker present.
      if (!window.shopify?.resourcePicker) setPickerUnavailable(true);
      return;
    }

    onChange(chosen);
  }

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="span" variant="bodyMd" fontWeight="medium">
          {label}
        </Text>
        <InlineStack gap="200" blockAlign="center">
          {value.length > 0 ? <Badge>{`${value.length} selected`}</Badge> : null}
          <Button onClick={() => void browse()}>Browse</Button>
          {value.length > 0 ? (
            <Button variant="plain" tone="critical" onClick={() => onChange([])}>
              Clear
            </Button>
          ) : null}
        </InlineStack>
      </InlineStack>

      <Text as="p" variant="bodySm" tone="subdued">
        {helpText}
      </Text>

      {value.length > 0 ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {value.slice(0, 5).map(describe).join(', ')}
          {value.length > 5 ? ` and ${value.length - 5} more` : ''}
        </Text>
      ) : null}

      {pickerUnavailable ? (
        <TextField
          label={`Add a ${type} by ID`}
          value={manual}
          onChange={setManual}
          autoComplete="off"
          placeholder={`gid://shopify/${type === 'product' ? 'Product' : 'Collection'}/123456`}
          helpText="The picker is unavailable here, so IDs have to be pasted."
          connectedRight={
            <Button
              disabled={manual.trim() === ''}
              onClick={() => {
                onChange([...value, manual.trim()]);
                setManual('');
              }}
            >
              Add
            </Button>
          }
        />
      ) : null}
    </BlockStack>
  );
}

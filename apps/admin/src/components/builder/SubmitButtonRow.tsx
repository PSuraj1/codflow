import { Badge, BlockStack, Button, Icon, InlineStack, Text, Tooltip } from '@shopify/polaris';
import { CheckCircleIcon, EditIcon } from '@shopify/polaris-icons';

/**
 * The submit button, shown at the foot of the field list.
 *
 * It is not a field — it has no key, carries no value and cannot be reordered,
 * deleted or hidden, because a form with no way to submit it is not a form.
 * But it *renders* at the end of the shopper's form, and leaving it out of the
 * builder made the list look like it stopped one row early: a merchant reading
 * top to bottom saw their last field and no way to reach the button underneath
 * it, which is the one piece of copy most likely to need changing.
 *
 * So it appears in the list, in position, and says plainly why it has fewer
 * controls than the rows above it.
 */

interface Props {
  label: string;
  isSelected: boolean;
  onSelect: () => void;
}

export function SubmitButtonRow({ label, isSelected, onSelect }: Props) {
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        // Dashed, to read as "always here" rather than as another draggable row.
        border: `1px dashed ${
          isSelected ? 'var(--p-color-border-emphasis)' : 'var(--p-color-border)'
        }`,
        background: isSelected
          ? 'var(--p-color-bg-surface-selected)'
          : 'var(--p-color-bg-surface-secondary)',
      }}
    >
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <span aria-hidden="true" style={{ display: 'flex' }}>
            <Icon source={CheckCircleIcon} tone="subdued" />
          </span>

          <BlockStack gap="050">
            <InlineStack gap="150" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="medium">
                {label}
              </Text>
              <Tooltip content="Every form ends with this button. It cannot be moved, hidden or removed — but its wording is yours.">
                <Badge>Submit button</Badge>
              </Tooltip>
            </InlineStack>

            <Text as="span" variant="bodySm" tone="subdued">
              Always last · colours come from your branding
            </Text>
          </BlockStack>
        </InlineStack>

        <Button
          icon={EditIcon}
          variant="tertiary"
          onClick={onSelect}
          accessibilityLabel="Edit the submit button"
        />
      </InlineStack>
    </div>
  );
}

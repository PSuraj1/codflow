import { useCallback, type DragEvent } from 'react';
import {
  Badge,
  BlockStack,
  Button,
  Icon,
  InlineStack,
  Text,
  Tooltip,
} from '@shopify/polaris';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  DeleteIcon,
  DragHandleIcon,
  EditIcon,
} from '@shopify/polaris-icons';
import type { FormFieldDefinition } from '@codflow/shared';
import { fieldMeta } from './fieldCatalogue';

/**
 * One row in the field list.
 *
 * Reordering is offered two ways, deliberately. Native HTML5 drag-and-drop is
 * what a merchant reaches for, but it is effectively unusable with a keyboard
 * or a screen reader — the drag events never fire. The up/down buttons are not
 * a fallback for old browsers; they are the accessible path, and Shopify's app
 * review checks for exactly this.
 */

interface Props {
  field: FormFieldDefinition;
  index: number;
  total: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string) => void;
}

export function FieldRow({
  field,
  index,
  total,
  isSelected,
  onSelect,
  onMove,
  onDelete,
  onToggleEnabled,
}: Props) {
  const meta = fieldMeta(field.type);

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox refuses to start a drag unless some data is set.
      event.dataTransfer.setData('text/plain', String(index));
    },
    [index],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Without preventDefault the element is not a valid drop target and the
    // drop event never fires — the single most common HTML5 DnD mistake.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const from = Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
      if (Number.isFinite(from) && from !== index) onMove(from, index);
    },
    [index, onMove],
  );

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${isSelected ? 'var(--p-color-border-emphasis)' : 'var(--p-color-border)'}`,
        background: isSelected ? 'var(--p-color-bg-surface-selected)' : 'var(--p-color-bg-surface)',
        opacity: field.enabled ? 1 : 0.55,
        cursor: 'grab',
      }}
    >
      <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <span aria-hidden="true" style={{ display: 'flex' }}>
            <Icon source={DragHandleIcon} tone="subdued" />
          </span>

          <BlockStack gap="050">
            <InlineStack gap="150" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="medium">
                {field.label}
              </Text>
              {field.validation.required ? <Badge tone="critical">Required</Badge> : null}
              {field.system ? (
                <Tooltip content="Built-in field — it can be reordered, relabelled or hidden, but not deleted.">
                  <Badge>Built-in</Badge>
                </Tooltip>
              ) : null}
              {field.conditional ? <Badge tone="info">Conditional</Badge> : null}
              {!field.enabled ? <Badge tone="warning">Hidden</Badge> : null}
            </InlineStack>

            <Text as="span" variant="bodySm" tone="subdued">
              {meta?.label ?? field.type} · {field.key}
            </Text>
          </BlockStack>
        </InlineStack>

        <InlineStack gap="100" wrap={false}>
          <Button
            icon={ChevronUpIcon}
            variant="tertiary"
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
            accessibilityLabel={`Move ${field.label} up`}
          />
          <Button
            icon={ChevronDownIcon}
            variant="tertiary"
            disabled={index === total - 1}
            onClick={() => onMove(index, index + 1)}
            accessibilityLabel={`Move ${field.label} down`}
          />
          <Button
            icon={EditIcon}
            variant="tertiary"
            onClick={() => onSelect(field.id)}
            accessibilityLabel={`Edit ${field.label}`}
          />
          {/*
            Built-in fields expose a hide toggle instead of a delete button.
            The order pipeline reads them by key, so removing one would break
            order creation rather than merely changing the form — which is why
            the server refuses it too.
          */}
          {field.system ? (
            <Button
              variant="tertiary"
              onClick={() => onToggleEnabled(field.id)}
              accessibilityLabel={`${field.enabled ? 'Hide' : 'Show'} ${field.label}`}
            >
              {field.enabled ? 'Hide' : 'Show'}
            </Button>
          ) : (
            <Button
              icon={DeleteIcon}
              variant="tertiary"
              tone="critical"
              onClick={() => onDelete(field.id)}
              accessibilityLabel={`Delete ${field.label}`}
            />
          )}
        </InlineStack>
      </InlineStack>
    </div>
  );
}

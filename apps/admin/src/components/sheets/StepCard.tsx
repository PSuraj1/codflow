import type { ReactNode } from 'react';
import { Badge, BlockStack, Box, Button, Card, Icon, InlineStack, Text } from '@shopify/polaris';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '@shopify/polaris-icons';

/**
 * One numbered step of the setup sequence.
 *
 * Collapsible, with the completed state visible from the header. Setup is
 * inherently ordered — you cannot pick a spreadsheet before connecting an
 * account, or map columns before picking a sheet — and showing all three
 * expanded at once presents choices that are not yet actionable.
 *
 * A completed step collapses but stays reachable: merchants come back to change
 * the sheet or the mapping far more often than they connect an account, so
 * hiding a finished step behind an edit mode would cost them a click every
 * time.
 */

interface Props {
  step: number;
  title: string;
  completed: boolean;
  open: boolean;
  onToggle: () => void;
  /** Shown in the header when the step is collapsed and complete. */
  summary?: ReactNode;
  /** Blocks interaction until the previous step is done. */
  disabled?: boolean;
  children: ReactNode;
}

export function StepCard({
  step,
  title,
  completed,
  open,
  onToggle,
  summary,
  disabled = false,
  children,
}: Props) {
  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            {/*
              The step number doubles as the completion indicator — a tick
              replaces the digit once done, so the header carries both pieces of
              state in one glance.
            */}
            {/*
              A light success surface with a success-toned tick, rather than a
              filled green circle with a white glyph. Polaris offers no inverse
              tone for `Icon`, so the filled variant would need a hardcoded
              white — which breaks the moment the merchant's admin is in dark
              mode. This pairing is the one the token system actually supports.
            */}
            <Box
              background={completed ? 'bg-surface-success' : 'bg-surface-secondary'}
              borderRadius="full"
              minWidth="28px"
              padding="100"
            >
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                {completed ? (
                  <Icon source={CheckIcon} tone="success" />
                ) : (
                  <Text
                    as="span"
                    variant="bodySm"
                    fontWeight="semibold"
                    tone={disabled ? 'subdued' : undefined}
                  >
                    {step}
                  </Text>
                )}
              </div>
            </Box>

            <Text as="h2" variant="headingMd" tone={disabled ? 'subdued' : undefined}>
              {title}
            </Text>
          </InlineStack>

          <InlineStack gap="200" blockAlign="center" wrap={false}>
            {completed ? <Badge tone="success">Completed</Badge> : null}

            <Button
              variant="tertiary"
              disabled={disabled}
              onClick={onToggle}
              icon={open ? ChevronDownIcon : ChevronRightIcon}
              accessibilityLabel={`${open ? 'Close' : 'Open'} step ${step}: ${title}`}
            >
              {open ? 'Close' : 'Open'}
            </Button>
          </InlineStack>
        </InlineStack>

        {!open && completed && summary ? <Box paddingInlineStart="800">{summary}</Box> : null}

        {open ? <Box>{children}</Box> : null}
      </BlockStack>
    </Card>
  );
}

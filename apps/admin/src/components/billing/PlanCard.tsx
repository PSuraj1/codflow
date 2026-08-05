import { Badge, BlockStack, Box, Button, Card, Icon, InlineStack, Text } from '@shopify/polaris';
import { CheckIcon } from '@shopify/polaris-icons';
import { PLAN_RANK, type PlanDefinition, type Plan } from '@codflow/shared';

/**
 * One plan on the pricing screen.
 *
 * The button's wording is the whole design here. "Upgrade" on a plan the
 * merchant is already on, or on a cheaper one, is how a pricing page loses
 * trust — so the label is derived from where the plan sits relative to theirs,
 * and the current plan gets a badge and no button at all.
 *
 * Prices are labelled as indicative. Shopify charges in the merchant's own
 * currency at its own conversion, and quoting a total the invoice will not
 * match is a support ticket at best.
 */

export interface PlanCardProps {
  readonly definition: PlanDefinition;
  readonly currentPlan: Plan;
  readonly onSelect: (plan: Plan) => void;
  readonly busy?: boolean;
}

export function PlanCard({ definition, currentPlan, onSelect, busy = false }: PlanCardProps) {
  const isCurrent = definition.plan === currentPlan;
  const isUpgrade = PLAN_RANK[definition.plan] > PLAN_RANK[currentPlan];

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
            <Text as="h3" variant="headingMd">
              {definition.name}
            </Text>
            {isCurrent ? <Badge tone="success">Current plan</Badge> : null}
          </InlineStack>

          <Text as="p" variant="bodySm" tone="subdued">
            {definition.tagline}
          </Text>
        </BlockStack>

        <BlockStack gap="100">
          <InlineStack gap="100" blockAlign="baseline" wrap={false}>
            <Text as="p" variant="headingXl" fontWeight="semibold">
              {definition.monthlyUsd === 0 ? 'Free' : `$${definition.monthlyUsd}`}
            </Text>
            {definition.monthlyUsd > 0 ? (
              <Text as="span" variant="bodySm" tone="subdued">
                /month
              </Text>
            ) : null}
          </InlineStack>

          {definition.monthlyUsd > 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {definition.trialDays > 0
                ? `${definition.trialDays}-day free trial · billed by Shopify in your currency`
                : 'Billed by Shopify in your currency'}
            </Text>
          ) : null}
        </BlockStack>

        <BlockStack gap="200">
          {definition.highlights.map((highlight) => (
            <InlineStack key={highlight} gap="150" blockAlign="start" wrap={false}>
              <Box>
                <Icon source={CheckIcon} tone="success" />
              </Box>
              <Text as="span" variant="bodySm">
                {highlight}
              </Text>
            </InlineStack>
          ))}
        </BlockStack>

        <Button
          variant={isUpgrade ? 'primary' : 'secondary'}
          disabled={isCurrent || busy}
          loading={busy}
          onClick={() => onSelect(definition.plan)}
          fullWidth
        >
          {isCurrent ? 'Your plan' : isUpgrade ? `Upgrade to ${definition.name}` : `Switch to ${definition.name}`}
        </Button>
      </BlockStack>
    </Card>
  );
}

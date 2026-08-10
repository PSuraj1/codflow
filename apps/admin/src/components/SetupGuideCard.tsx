import { useNavigate } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Icon,
  InlineStack,
  ProgressBar,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { CheckCircleIcon, AlertTriangleIcon } from '@shopify/polaris-icons';
import { SetupStepState, type SetupStep } from '@codflow/shared';
import { navigateTop } from '../lib/appBridge';
import { useDismissSetupGuide, useSetupGuide } from '../hooks/useSetupGuide';

/**
 * Setup checklist.
 *
 * Sits above the stats on the dashboard until the merchant finishes or hides
 * it. The app is fully usable the whole time — this is a guide, not a gate,
 * which is both the better experience and what the App Store's "well
 * integrated" criterion asks for.
 *
 * Three details that are not obvious:
 *
 *  - **Completion is derived server-side**, so a step un-ticks when it stops
 *    being true. Switching theme loses the app embed, and this card is the only
 *    place a merchant would ever find that out.
 *  - **`UNKNOWN` is rendered differently from "not done".** The embed check
 *    needs an Admin API call that can fail on its own; telling a merchant who
 *    did enable it that they did not would send them to fix nothing.
 *  - **State is never carried by colour alone.** Each row has an icon *and* a
 *    badge with words, because a red dot and a green dot are the same dot to a
 *    substantial number of merchants.
 */

function StepRow({ step }: { step: SetupStep }) {
  const navigate = useNavigate();

  const done = step.state === SetupStepState.DONE;
  const unknown = step.state === SetupStepState.UNKNOWN;

  return (
    <InlineStack gap="300" wrap={false} blockAlign="start">
      <Box paddingBlockStart="050">
        {done ? (
          <Icon source={CheckCircleIcon} tone="success" />
        ) : unknown ? (
          <Icon source={AlertTriangleIcon} tone="caution" />
        ) : (
          // An empty circle, drawn rather than imported: Polaris has no
          // "unstarted" icon, and a grey filled dot reads as disabled.
          <Box
            borderColor="border"
            borderWidth="025"
            borderRadius="full"
            minHeight="20px"
            minWidth="20px"
          />
        )}
      </Box>

      <BlockStack gap="100">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="h3" variant="bodyMd" fontWeight={done ? 'regular' : 'semibold'}>
            {step.title}
          </Text>
          {step.optional ? <Badge tone="info">Optional</Badge> : null}
          {unknown ? <Badge tone="attention">Could not check</Badge> : null}
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">
          {step.summary}
        </Text>

        {step.actionLabel ? (
          <InlineStack>
            <Button
              variant={done || step.optional ? 'plain' : 'primary'}
              // The theme editor is not a route in this app. `navigateTop`
              // escapes the embedded frame without reading a cross-origin
              // Location, which throws on every embedded page view.
              onClick={() =>
                step.actionUrl
                  ? navigateTop(step.actionUrl)
                  : step.actionPath
                    ? navigate(step.actionPath)
                    : undefined
              }
              disabled={!step.actionUrl && !step.actionPath}
            >
              {step.actionLabel}
            </Button>
          </InlineStack>
        ) : null}
      </BlockStack>
    </InlineStack>
  );
}

export function SetupGuideCard() {
  const { data, isPending, error } = useSetupGuide();
  const dismiss = useDismissSetupGuide();

  // Dismissed is permanent and checked before anything renders, so a merchant
  // who hid this never sees it flash back on a slow load.
  if (data?.dismissed) return null;

  // A failed guide is not worth a red box on the dashboard — the merchant did
  // nothing wrong and there is nothing to act on. Store health still reports
  // anything genuinely broken.
  if (error) return null;

  if (isPending) {
    return (
      <Card>
        <SkeletonBodyText lines={5} />
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
          <Text as="h2" variant="headingMd">
            {data.complete ? 'You are ready to take COD orders' : 'Set up CODkar'}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {data.requiredDone} of {data.requiredTotal}
          </Text>
        </InlineStack>

        <ProgressBar
          progress={
            data.requiredTotal === 0 ? 0 : (data.requiredDone / data.requiredTotal) * 100
          }
          size="small"
          tone={data.complete ? 'success' : 'primary'}
        />

        <BlockStack gap="400">
          {data.steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </BlockStack>

        <InlineStack align="end">
          <Button
            variant="plain"
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate(data.requiredDone)}
          >
            {data.complete ? 'Hide this' : 'Dismiss'}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

import {
  Badge,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Text,
} from '@shopify/polaris';
import type { StuckOrderSummary } from '@codflow/shared';
import { useRetryPush, useVerifyOrder } from '../../hooks/useOrders';
import { formatMoney } from '../charts/chartTokens';

/**
 * One order that has not reached Shopify.
 *
 * The badges report only what the record actually says — the risk decision, the
 * OTP flags, the attempt count. Whether a retry will be *allowed* is a gate
 * decision, and the gates live on the server; re-deriving them here would give
 * the merchant a second opinion that drifts from the real one the moment either
 * side changes. So the retry is always offered and the server's refusal, which
 * names the reason, is what they see.
 */

interface Props {
  order: StuckOrderSummary;
}

function ageOf(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function StuckOrderRow({ order }: Props) {
  const retry = useRetryPush();
  const verify = useVerifyOrder();

  const heldForReview = order.riskAction === 'REVIEW' || order.riskAction === 'CHALLENGE_OTP';
  const blocked = order.riskAction === 'BLOCK';
  const awaitingOtp = order.otpRequired && !order.otpVerified;

  return (
    <Box
      padding="300"
      borderRadius="200"
      borderWidth="025"
      borderColor="border"
      background="bg-surface"
    >
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {order.reference}
              </Text>

              {order.status === 'FAILED' ? <Badge tone="critical">Failed</Badge> : null}
              {order.status === 'CONFIRMED' && order.pushAttempts > 0 ? (
                <Badge tone="critical">Not getting through</Badge>
              ) : null}
              {order.status === 'CONFIRMED' && order.pushAttempts === 0 ? (
                <Badge tone="attention">Waiting</Badge>
              ) : null}
              {order.status === 'PENDING_OTP' ? <Badge>Not verified</Badge> : null}

              {blocked ? <Badge tone="critical">Blocked by fraud rules</Badge> : null}
              {heldForReview ? <Badge tone="warning">Held for review</Badge> : null}
              {awaitingOtp ? <Badge tone="warning">Waiting on OTP</Badge> : null}
            </InlineStack>

            <Text as="span" variant="bodySm" tone="subdued">
              {formatMoney(order.total, order.currency)} · {ageOf(order.createdAt)} ·{' '}
              {order.pushAttempts === 0
                ? 'never attempted'
                : `${order.pushAttempts} attempt${order.pushAttempts === 1 ? '' : 's'}`}
            </Text>
          </BlockStack>

          <InlineStack gap="200">
            {/*
              Only where verification is actually the hold. Nothing sends a code
              yet, so without this an order requiring OTP waits forever with no
              action able to release it.
            */}
            {awaitingOtp ? (
              <Button
                variant="primary"
                loading={verify.isPending}
                onClick={() => verify.mutate(order.reference)}
                accessibilityLabel={`Mark ${order.reference} as verified`}
              >
                Mark verified
              </Button>
            ) : null}

            <Button
              loading={retry.isPending}
              onClick={() => retry.mutate(order.reference)}
              accessibilityLabel={`Send ${order.reference} to Shopify again`}
            >
              Retry
            </Button>
          </InlineStack>
        </InlineStack>

        {/* The push failure verbatim — usually a Shopify API message, and the
            only thing that says what to actually change. */}
        {order.pushError ? (
          <Box background="bg-surface-critical" padding="200" borderRadius="100">
            <Text as="p" variant="bodySm" breakWord>
              {order.pushError}
            </Text>
          </Box>
        ) : null}
      </BlockStack>
    </Box>
  );
}

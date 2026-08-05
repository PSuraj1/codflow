import { useNavigate } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from '@shopify/polaris';
import { MAX_ORDER_BUMPS } from '@codflow/shared';
import { useOrderBumps } from '../hooks/useOrderBumps';

/**
 * The upsells hub.
 *
 * Three ideas belong in this section; one of them is built. The other two are
 * listed because a merchant looking for them should find out here rather than
 * by searching the app — but they are shown as *not available* rather than as
 * buttons that lead nowhere. This codebase has twice shipped a control that
 * saved a value nothing ever read, and a dead button is the same mistake with
 * a shorter fuse.
 */
export function UpsellsPage() {
  const navigate = useNavigate();
  const { data: bumps } = useOrderBumps();

  const live = bumps?.filter((bump) => bump.isEnabled).length ?? 0;

  return (
    <Page
      title="Upsells and downsells"
      subtitle="Extra offers that raise the value of a cash-on-delivery order"
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    1-tick upsell / order bump
                  </Text>
                  {live > 0 ? <Badge tone="success">{`${live} live`}</Badge> : null}
                </InlineStack>

                <Text as="p" variant="bodyMd" tone="subdued">
                  A tick box on the COD form that adds a little extra to the order — shipping
                  protection, priority processing, extended warranty, gift wrapping. Up to{' '}
                  {MAX_ORDER_BUMPS} add-ons, each priced as a flat amount.
                </Text>

                <InlineStack>
                  <Button variant="primary" onClick={() => navigate('/upsells/bumps')}>
                    Order bumps
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    1-click upsells
                  </Text>
                  <Badge>Not available yet</Badge>
                </InlineStack>

                <Text as="p" variant="bodyMd" tone="subdued">
                  Extra offers shown before the shopper fills in the form, or straight after they
                  finish. Accepting or rejecting one moves to the next.
                </Text>

                <Text as="p" variant="bodySm" tone="subdued">
                  Not built. It needs an offer sequence that survives a shopper closing the tab
                  half-way through, which is a different piece of work from the tick box above
                  rather than a variation on it.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Downsells
                  </Text>
                  <Badge>Not available yet</Badge>
                </InlineStack>

                <Text as="p" variant="bodyMd" tone="subdued">
                  A discount offered when a shopper closes the form, to recover a sale that was
                  about to be lost.
                </Text>

                <Text as="p" variant="bodySm" tone="subdued">
                  Not built. It needs exit detection in the storefront bundle and a discount that
                  survives into the order, neither of which exists today.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

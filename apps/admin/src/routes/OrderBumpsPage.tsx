import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import { MAX_ORDER_BUMPS, type OrderBumpSummary } from '@codflow/shared';
import {
  useCreateOrderBump,
  useDeleteOrderBump,
  useOrderBumps,
  useUpdateOrderBump,
} from '../hooks/useOrderBumps';
import { useSession } from '../hooks/useSession';

/**
 * Order bumps — the tick-box add-ons on the COD form.
 *
 * Each row edits in place and saves on its own, rather than the whole list
 * sharing one save bar. A merchant adjusting the price of one add-on should not
 * be made to think about the other four, and a list-wide save would make
 * deleting one row look like it discarded edits to the others.
 */
export function OrderBumpsPage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: bumps, isPending, error } = useOrderBumps();

  const createBump = useCreateOrderBump();
  const currency = session?.shop.currencyCode ?? '';

  if (isPending) {
    return (
      <Page title="Order bumps">
        <Card>
          <SkeletonBodyText lines={8} />
        </Card>
      </Page>
    );
  }

  if (error || !bumps) {
    return (
      <Page title="Order bumps">
        <Banner tone="critical" title="Could not load your add-ons">
          <p>{error?.message ?? 'Something went wrong.'}</p>
        </Banner>
      </Page>
    );
  }

  const atLimit = bumps.length >= MAX_ORDER_BUMPS;

  return (
    <Page
      title="Order bumps"
      subtitle="Tick-box add-ons shown on your COD form"
      backAction={{ content: 'Upsells', onAction: () => navigate('/upsells') }}
      primaryAction={{
        content: 'Add an add-on',
        disabled: atLimit || createBump.isPending,
        loading: createBump.isPending,
        onAction: () =>
          createBump.mutate({
            title: 'Shipping protection',
            description: 'Covers loss or damage in transit.',
            price: '49',
            isEnabled: true,
            position: bumps.length,
          }),
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {atLimit ? (
              <Banner tone="info">
                <p>
                  {MAX_ORDER_BUMPS} is the limit. The tick boxes sit between a shopper and the
                  submit button, and a form with more add-ons than fields is one people abandon.
                </p>
              </Banner>
            ) : null}

            {bumps.length === 0 ? (
              <Card>
                <EmptyState
                  heading="No add-ons yet"
                  image=""
                  action={{
                    content: 'Add an add-on',
                    onAction: () =>
                      createBump.mutate({
                        title: 'Shipping protection',
                        description: 'Covers loss or damage in transit.',
                        price: '49',
                        isEnabled: true,
                        position: 0,
                      }),
                  }}
                >
                  <p>
                    An add-on is a tick box on your COD form that adds a flat amount to the order
                    — shipping protection, priority processing, gift wrapping.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              bumps.map((bump) => <BumpCard key={bump.id} bump={bump} currency={currency} />)
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function BumpCard({ bump, currency }: { bump: OrderBumpSummary; currency: string }) {
  const update = useUpdateOrderBump();
  const remove = useDeleteOrderBump();

  const [draft, setDraft] = useState<OrderBumpSummary>(bump);
  const dirty = JSON.stringify(draft) !== JSON.stringify(bump);

  const patch = (values: Partial<OrderBumpSummary>) =>
    setDraft((current) => ({ ...current, ...values }));

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingMd">
              {draft.title || 'Untitled add-on'}
            </Text>
            <Badge tone={draft.isEnabled ? 'success' : undefined}>
              {draft.isEnabled ? 'On' : 'Off'}
            </Badge>
          </InlineStack>

          <Checkbox
            label="Show this add-on"
            checked={draft.isEnabled}
            onChange={(isEnabled) => patch({ isEnabled })}
          />
        </InlineStack>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <TextField
            label="Title"
            value={draft.title}
            onChange={(title) => patch({ title })}
            autoComplete="off"
            maxLength={80}
            helpText="What the shopper sees next to the tick box."
          />
          <TextField
            label="Price"
            value={draft.price}
            onChange={(price) => patch({ price })}
            autoComplete="off"
            prefix={currency}
            helpText="Added once per order, whatever the cart contains."
          />
        </InlineGrid>

        <TextField
          label="Description"
          value={draft.description ?? ''}
          onChange={(description) => patch({ description: description === '' ? null : description })}
          autoComplete="off"
          maxLength={200}
          multiline={2}
          helpText="Optional. A line explaining what they get."
        />

        <InlineStack align="space-between">
          <Button
            tone="critical"
            variant="plain"
            loading={remove.isPending}
            onClick={() => remove.mutate(bump.id)}
          >
            Delete
          </Button>

          <InlineStack gap="200">
            {dirty ? <Button onClick={() => setDraft(bump)}>Discard</Button> : null}
            <Button
              variant="primary"
              disabled={!dirty}
              loading={update.isPending}
              onClick={() => update.mutate({ ...draft, id: bump.id })}
            >
              Save
            </Button>
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

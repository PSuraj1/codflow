import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  BlockStack,
  Banner,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Modal,
  Page,
  ResourceItem,
  ResourceList,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import { useCreateForm, useDeleteForm, useDuplicateForm, useForms } from '../hooks/useForms';
import { SectionTabs, COD_FORM_TABS } from '../components/SectionTabs';

/**
 * Form list.
 *
 * The active form is marked and cannot be deleted from here — the server
 * refuses it too, because a shop with no active form has no COD button, and
 * discovering that from a silently empty storefront is exactly the failure this
 * app exists to avoid.
 */
export function FormsPage() {
  const navigate = useNavigate();
  const { data: forms, isPending, error } = useForms();

  const createForm = useCreateForm();
  const duplicateForm = useDuplicateForm();
  const deleteForm = useDeleteForm();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');

  const handleCreate = useCallback(() => {
    createForm.mutate(
      { name: name.trim() },
      {
        onSuccess: (form) => {
          setCreateOpen(false);
          setName('');
          // Straight into the builder: a form with default fields is not the
          // destination, it is the starting point.
          navigate(`/forms/${form.id}`);
        },
      },
    );
  }, [createForm, name, navigate]);

  if (isPending) {
    return (
      <Page title="COD forms">
        <Card>
          <SkeletonBodyText lines={6} />
        </Card>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="COD forms">
        <Banner tone="critical" title="Could not load your forms">
          <p>{error.message}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="COD forms"
      subtitle="The form shoppers fill in when they choose cash on delivery"
      primaryAction={{ content: 'Create form', onAction: () => setCreateOpen(true) }}
    >
      <SectionTabs tabs={COD_FORM_TABS} />

      <Layout>
        <Layout.Section>
          {forms.length === 0 ? (
            <Card>
              <EmptyState
                heading="No forms yet"
                action={{ content: 'Create your first form', onAction: () => setCreateOpen(true) }}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>A COD form collects the delivery details you need to fulfil an order.</p>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <ResourceList
                resourceName={{ singular: 'form', plural: 'forms' }}
                items={[...forms]}
                renderItem={(form) => (
                  <ResourceItem
                    id={form.id}
                    onClick={() => navigate(`/forms/${form.id}`)}
                    accessibilityLabel={`Edit ${form.name}`}
                  >
                    <InlineStack align="space-between" blockAlign="center" wrap={false}>
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {form.name}
                          </Text>
                          {form.active ? <Badge tone="success">Active</Badge> : <Badge>Draft</Badge>}
                          {form.requireOtp ? <Badge tone="info">OTP</Badge> : null}
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {form.fields.filter((field) => field.enabled).length} visible fields ·{' '}
                          {form.fields.filter((field) => field.conditional).length} conditional
                        </Text>
                      </BlockStack>

                      <InlineStack gap="200">
                        <Button
                          variant="tertiary"
                          loading={duplicateForm.isPending}
                          onClick={() => duplicateForm.mutate(form.id)}
                        >
                          Duplicate
                        </Button>
                        <Button
                          variant="tertiary"
                          tone="critical"
                          // The active form has no delete path, here or on the
                          // server. Disabling with an explanation is clearer
                          // than a request that always fails.
                          disabled={form.active || form.isDefault}
                          loading={deleteForm.isPending}
                          onClick={() => deleteForm.mutate(form.id)}
                        >
                          Delete
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </ResourceItem>
                )}
              />
            </Card>
          )}
        </Layout.Section>
      </Layout>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a COD form"
        primaryAction={{
          content: 'Create',
          onAction: handleCreate,
          disabled: name.trim().length === 0,
          loading: createForm.isPending,
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setCreateOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label="Form name"
            value={name}
            onChange={setName}
            autoComplete="off"
            placeholder="Express delivery form"
            helpText="Only you see this. New forms start as drafts with the standard delivery fields, so nothing changes on your storefront until you activate one."
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}

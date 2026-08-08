import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Layout,
  Link,
  Modal,
  Page,
  Select,
  SkeletonBodyText,
  Text,
  TextField,
} from '@shopify/polaris';
import { DEFAULT_COLUMN_MAPPING } from '@codflow/shared';
import {
  mappingChanged,
  useBackfill,
  useConnectGoogle,
  useCreateSpreadsheet,
  useDisconnectGoogle,
  useSelectSpreadsheet,
  useSheetsOverview,
  useSpreadsheets,
  useUpdateMapping,
  useUpdateSheetSettings,
  useWorksheets,
} from '../hooks/useSheets';
import { StepCard } from '../components/sheets/StepCard';
import { ColumnMapper, type MappedColumn } from '../components/sheets/ColumnMapper';
import { SaveBar } from '../components/SaveBar';
import { SectionTabs, SETTINGS_TABS } from '../components/SectionTabs';

/**
 * Google Sheets settings.
 *
 * Three ordered steps — connect, choose a sheet, map the columns — because each
 * genuinely depends on the one before it. The sequence is enforced rather than
 * merely suggested: a merchant cannot open step two without an account, and the
 * API refuses the same request for the same reason.
 *
 * Which step is open is derived from what is done rather than held as
 * navigation state, so a merchant returning to a half-finished setup lands on
 * the step they stopped at instead of the top.
 */
export function GoogleSheetsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const { data, isPending, error } = useSheetsOverview();

  const connect = useConnectGoogle();
  const disconnect = useDisconnectGoogle();
  const createSpreadsheet = useCreateSpreadsheet();
  const selectSpreadsheet = useSelectSpreadsheet();
  const updateMapping = useUpdateMapping();
  const updateSettings = useUpdateSheetSettings();
  const backfill = useBackfill();

  const [openStep, setOpenStep] = useState<number | null>(null);
  const [openedManually, setOpenedManually] = useState(false);
  const [columns, setColumns] = useState<MappedColumn[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('CODkar Orders');
  const [pickerId, setPickerId] = useState<string | null>(null);

  const account = data?.account ?? null;
  const config = data?.config ?? null;

  const hasAccount = Boolean(account && !account.revokedAt);
  const hasSheet = Boolean(config?.spreadsheetId);
  const hasMapping = (config?.columnMapping.length ?? 0) > 0;

  const spreadsheets = useSpreadsheets(openStep === 2 && hasAccount);
  const worksheets = useWorksheets(pickerId);

  // Seeds the editable mapping from the server's copy, and re-seeds after a
  // save so the unsaved-changes bar clears.
  useEffect(() => {
    if (config) {
      setColumns(config.columnMapping.map(({ source, header }) => ({ source, header })));
    } else {
      setColumns(DEFAULT_COLUMN_MAPPING.map(({ source, header }) => ({ source, header })));
    }
  }, [config]);

  // Opens the first incomplete step, unless the merchant has since chosen one.
  useEffect(() => {
    if (openedManually || isPending) return;

    if (!hasAccount) setOpenStep(1);
    else if (!hasSheet) setOpenStep(2);
    else if (!hasMapping) setOpenStep(3);
    else setOpenStep(null);
  }, [hasAccount, hasSheet, hasMapping, isPending, openedManually]);

  const toggleStep = useCallback((step: number) => {
    setOpenedManually(true);
    setOpenStep((current) => (current === step ? null : step));
  }, []);

  const dirty = useMemo(
    () => Boolean(config) && mappingChanged(config?.columnMapping ?? [], columns),
    [config, columns],
  );

  // The OAuth callback returns the merchant here with a flag rather than a
  // body, since they arrive as a top-level navigation. Cleared once read so a
  // refresh does not re-announce it.
  const connected = searchParams.get('google_connected');
  const googleError = searchParams.get('google_error');

  useEffect(() => {
    if (connected || googleError) {
      const timer = window.setTimeout(() => setSearchParams({}, { replace: true }), 6_000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [connected, googleError, setSearchParams]);

  if (isPending) {
    return (
      <Page title="Google Sheets">
        <Card>
          <SkeletonBodyText lines={8} />
        </Card>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Google Sheets">
        <Banner tone="critical" title="Could not load your Google Sheets settings">
          <p>{error.message}</p>
        </Banner>
      </Page>
    );
  }

  return (
    <Page
      title="Google Sheets"
      subtitle="Export COD orders to a Google Sheet as they come in"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
    >
      <SaveBar
        id="codflow-save-sheet-columns"
        dirty={dirty}
        loading={updateMapping.isPending}
        message="Unsaved column changes"
        onSave={() => updateMapping.mutate({ columns })}
        onDiscard={() =>
          setColumns(
            (config?.columnMapping ?? []).map(({ source, header }) => ({ source, header })),
          )
        }
      />

      <SectionTabs tabs={SETTINGS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {googleError ? (
              <Banner tone="warning" title="Google did not grant access">
                <p>
                  {googleError === 'access_denied'
                    ? 'You cancelled the Google permission screen. Nothing was changed.'
                    : `Google returned: ${googleError}`}
                </p>
              </Banner>
            ) : null}

            {connected ? (
              <Banner tone="success" title="Google account connected">
                <p>Now choose the spreadsheet your orders should be written to.</p>
              </Banner>
            ) : null}

            {account?.revokedAt ? (
              <Banner
                tone="critical"
                title="Your Google connection stopped working"
                action={{ content: 'Reconnect', onAction: () => connect.mutate() }}
              >
                <p>
                  {account.lastError ??
                    'Google revoked access. Orders are not being exported until you reconnect.'}
                </p>
              </Banner>
            ) : null}

            {config && !config.isActive && config.lastError ? (
              <Banner
                tone="critical"
                title="Exporting is paused"
                action={{
                  content: 'Resume',
                  onAction: () => updateSettings.mutate({ isActive: true }),
                }}
              >
                <p>{config.lastError}</p>
              </Banner>
            ) : null}

            {/* ---- Step 1 */}
            <StepCard
              step={1}
              title="Connect your Google account"
              completed={hasAccount}
              open={openStep === 1}
              onToggle={() => toggleStep(1)}
              summary={
                account ? (
                  <Text as="span" variant="bodyMd" tone="subdued">
                    Connected as {account.email}
                  </Text>
                ) : null
              }
            >
              {hasAccount && account ? (
                <BlockStack gap="300">
                  <InlineStack gap="300" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      Connected as <strong>{account.email}</strong>
                    </Text>
                    <Badge tone="success">Active</Badge>
                  </InlineStack>

                  <Text as="p" variant="bodySm" tone="subdued">
                    CODkar can only see spreadsheets it created, plus any you pick yourself. It has
                    no access to the rest of your Google Drive.
                  </Text>

                  <InlineStack gap="200">
                    <Button onClick={() => connect.mutate()} loading={connect.isPending}>
                      Reconnect
                    </Button>
                    <Button
                      tone="critical"
                      variant="tertiary"
                      onClick={() => disconnect.mutate()}
                      loading={disconnect.isPending}
                    >
                      Disconnect
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  <Text as="p" variant="bodyMd">
                    Sign in with the Google account that owns the spreadsheet you want your orders
                    written to.
                  </Text>
                  <Box>
                    <Button variant="primary" onClick={() => connect.mutate()} loading={connect.isPending}>
                      Connect Google account
                    </Button>
                  </Box>
                </BlockStack>
              )}
            </StepCard>

            {/* ---- Step 2 */}
            <StepCard
              step={2}
              title="Select your Google Sheet"
              completed={hasSheet}
              open={openStep === 2}
              onToggle={() => toggleStep(2)}
              disabled={!hasAccount}
              summary={
                config ? (
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Orders are exported to
                    </Text>
                    <Link url={config.spreadsheetUrl ?? '#'} external>
                      {config.spreadsheetName ?? config.spreadsheetId}
                    </Link>
                    <Text as="span" variant="bodySm" tone="subdued">
                      ({config.worksheetName})
                    </Text>
                  </InlineStack>
                ) : null
              }
            >
              <BlockStack gap="400">
                {config ? (
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd">
                        Currently exporting to{' '}
                        <Link url={config.spreadsheetUrl ?? '#'} external>
                          {config.spreadsheetName ?? config.spreadsheetId}
                        </Link>
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Tab: {config.worksheetName} · {config.totalSynced} synced ·{' '}
                        {config.totalFailed} failed
                      </Text>
                    </BlockStack>
                  </InlineStack>
                ) : null}

                <InlineStack gap="200">
                  <Button variant="primary" onClick={() => setCreateOpen(true)}>
                    Create a new spreadsheet
                  </Button>
                </InlineStack>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Or pick an existing one
                  </Text>

                  {spreadsheets.isPending ? (
                    <SkeletonBodyText lines={2} />
                  ) : spreadsheets.data && spreadsheets.data.length > 0 ? (
                    <InlineStack gap="200" blockAlign="end">
                      <Box width="70%">
                        <Select
                          label="Spreadsheet"
                          options={[
                            { label: 'Choose a spreadsheet…', value: '' },
                            ...spreadsheets.data.map((sheet) => ({
                              label: sheet.name,
                              value: sheet.id,
                            })),
                          ]}
                          value={pickerId ?? ''}
                          onChange={(value) => setPickerId(value || null)}
                        />
                      </Box>

                      <Button
                        disabled={!pickerId}
                        loading={selectSpreadsheet.isPending}
                        onClick={() =>
                          pickerId &&
                          selectSpreadsheet.mutate({
                            spreadsheetId: pickerId,
                            ...(worksheets.data?.[0]
                              ? { worksheetName: worksheets.data[0].title }
                              : {}),
                          })
                        }
                      >
                        Use this sheet
                      </Button>
                    </InlineStack>
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No spreadsheets available yet. CODkar can only see files it created, so
                      create one above to get started.
                    </Text>
                  )}
                </BlockStack>
              </BlockStack>
            </StepCard>

            {/* ---- Step 3 */}
            <StepCard
              step={3}
              title="Select fields you want to export to Google Sheet"
              completed={hasMapping}
              open={openStep === 3}
              onToggle={() => toggleStep(3)}
              disabled={!hasSheet}
              summary={
                <Text as="span" variant="bodyMd" tone="subdued">
                  {config?.columnMapping.length ?? 0} columns mapped
                </Text>
              }
            >
              <ColumnMapper
                columns={columns}
                customFields={data?.customFieldSources ?? []}
                onChange={setColumns}
              />
            </StepCard>

            {/* ---- Layout options, mirroring the two checkboxes */}
            {hasSheet && config ? (
              <Card>
                <BlockStack gap="400">
                  <Checkbox
                    label="Use a single row per order in Google Sheets"
                    helpText="If enabled, all items in an order will be combined into a single row."
                    checked={config.layout.singleRowPerOrder}
                    onChange={(value) => updateSettings.mutate({ singleRowPerOrder: value })}
                  />

                  <Checkbox
                    label="Insert new orders at the top of the sheet"
                    helpText="If enabled, new orders will appear at the top of the sheet, just below the header, instead of at the bottom."
                    checked={config.layout.insertAtTop}
                    onChange={(value) => updateSettings.mutate({ insertAtTop: value })}
                  />

                  <Checkbox
                    label="Write a header row"
                    helpText="Adds your column headers to the first row if the sheet is empty."
                    checked={config.includeHeaders}
                    onChange={(value) => updateSettings.mutate({ includeHeaders: value })}
                  />

                  <Checkbox
                    label="Export new orders automatically"
                    helpText="Turn this off to stop exporting without losing your setup."
                    checked={config.autoSync}
                    onChange={(value) => updateSettings.mutate({ autoSync: value })}
                  />

                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">
                        Export existing orders
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Queues orders that are not in your sheet yet, oldest first.
                      </Text>
                    </BlockStack>

                    <Button onClick={() => backfill.mutate(200)} loading={backfill.isPending}>
                      Export existing orders
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a spreadsheet"
        primaryAction={{
          content: 'Create',
          loading: createSpreadsheet.isPending,
          disabled: newTitle.trim().length === 0,
          onAction: () =>
            createSpreadsheet.mutate(
              { title: newTitle.trim(), worksheetName: 'Orders' },
              { onSuccess: () => setCreateOpen(false) },
            ),
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setCreateOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label="Spreadsheet name"
            value={newTitle}
            onChange={setNewTitle}
            autoComplete="off"
            helpText="Created in the Google account you connected, and shared with nobody else."
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}

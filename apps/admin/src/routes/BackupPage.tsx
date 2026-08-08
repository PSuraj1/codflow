import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DropZone,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from '@shopify/polaris';
import { SETTINGS_EXPORT_VERSION, type SettingsImportResult } from '@codflow/shared';
import { useExportSettings, useImportSettings } from '../hooks/useSettingsTransfer';
import { SectionTabs, SETTINGS_TABS } from '../components/SectionTabs';

/**
 * Backup, restore and transfer.
 *
 * The export is the safety net for every other screen in this app: a merchant
 * about to change their fraud thresholds or rebuild their form has, until now,
 * had no way back to what worked.
 *
 * The import is the destructive half, and the page is arranged to say so. It
 * takes two deliberate actions — choose a file, then confirm what is in it —
 * because a single button that silently replaced a shop's whole configuration
 * would be the most dangerous control in the admin.
 */
export function BackupPage() {
  const navigate = useNavigate();
  const exportSettings = useExportSettings();
  const importSettings = useImportSettings();

  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SettingsImportResult | null>(null);

  /**
   * Parsed in the browser before anything is sent.
   *
   * Not a security check — the server validates the file properly and is the
   * only opinion that counts. This is so a merchant who picked the wrong file
   * finds out from a sentence rather than from a rejected upload, and can see
   * which store and date it came from before replacing their settings with it.
   */
  async function onDrop(files: File[]): Promise<void> {
    const next = files[0];
    setResult(null);

    if (!next) return;

    setFile(next);

    try {
      const body = JSON.parse(await next.text()) as Record<string, unknown>;

      if (typeof body.version !== 'number') {
        setParsed(null);
        setProblem('That file is not a CODkar settings export.');
        return;
      }

      if (body.version !== SETTINGS_EXPORT_VERSION) {
        setParsed(null);
        setProblem(
          `That file was made by a different version of CODkar (v${String(body.version)}). ` +
            `This version reads v${SETTINGS_EXPORT_VERSION}.`,
        );
        return;
      }

      setParsed(body);
      setProblem(null);
    } catch {
      setParsed(null);
      setProblem('That file is not valid JSON.');
    }
  }

  const from = typeof parsed?.shopDomain === 'string' ? parsed.shopDomain : null;
  const at = typeof parsed?.exportedAt === 'string' ? parsed.exportedAt.slice(0, 10) : null;

  return (
    <Page
      title="Import and export"
      subtitle="Back up your settings, or copy them to another store"
      backAction={{ content: 'Home', onAction: () => navigate('/') }}
    >
      <SectionTabs tabs={SETTINGS_TABS} />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Export
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Download a backup file. Use it to restore this store later, or to set up a second
                  store without redoing every screen.
                </Text>

                <InlineStack>
                  <Button
                    variant="primary"
                    loading={exportSettings.isPending}
                    onClick={() => exportSettings.mutate()}
                  >
                    Export
                  </Button>
                </InlineStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  Ad pixels and Google Sheets are never included — their access tokens are
                  encrypted and must not travel in a file you download. Order history and fraud
                  block lists are excluded too, because they are records about shoppers rather than
                  settings.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Import
                  </Text>
                  <Badge tone="warning">Replaces your settings</Badge>
                </InlineStack>

                <Text as="p" variant="bodyMd" tone="subdued">
                  Upload a backup file. Export this store first if you might want to come back.
                </Text>

                <DropZone accept="application/json" type="file" allowMultiple={false} onDrop={onDrop}>
                  {file ? <DropZone.FileUpload actionTitle={file.name} /> : <DropZone.FileUpload />}
                </DropZone>

                {problem ? (
                  <Banner tone="critical" title="That file cannot be used">
                    <p>{problem}</p>
                  </Banner>
                ) : null}

                {parsed ? (
                  <Banner tone="info" title="Ready to import">
                    <List>
                      {from ? <List.Item>From {from}</List.Item> : null}
                      {at ? <List.Item>Exported {at}</List.Item> : null}
                      <List.Item>
                        {Array.isArray(parsed.buttons) ? parsed.buttons.length : 0} buttons,{' '}
                        {Array.isArray(parsed.forms) ? parsed.forms.length : 0} forms,{' '}
                        {Array.isArray(parsed.fraudRules) ? parsed.fraudRules.length : 0} fraud
                        rules
                      </List.Item>
                    </List>
                  </Banner>
                ) : null}

                <InlineStack align="end">
                  <Button
                    tone="critical"
                    variant="primary"
                    disabled={!parsed}
                    loading={importSettings.isPending}
                    onClick={() =>
                      importSettings.mutate(parsed, {
                        onSuccess: (value) => {
                          setResult(value);
                          setParsed(null);
                          setFile(null);
                        },
                      })
                    }
                  >
                    Import
                  </Button>
                </InlineStack>

                {result ? (
                  <Banner tone="success" title="Settings imported">
                    <List>
                      <List.Item>
                        {result.buttons} buttons, {result.forms} forms, {result.fraudRules} fraud
                        rules
                      </List.Item>
                      {result.skipped.map((note) => (
                        <List.Item key={note}>{note}</List.Item>
                      ))}
                    </List>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

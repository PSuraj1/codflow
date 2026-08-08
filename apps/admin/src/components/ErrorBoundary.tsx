import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Banner, BlockStack, Box, Card, Page, Text } from '@shopify/polaris';

/**
 * Top-level error boundary.
 *
 * An embedded app that throws renders a blank iframe inside the Shopify admin,
 * with no indication that anything failed — the merchant sees an empty panel
 * and concludes the app is broken, which it is, but silently. Catching here
 * turns that into a visible message with a request id they can quote.
 *
 * Class component because React still offers no hook equivalent for
 * `componentDidCatch`.
 */

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console rather than a logging service: shipping merchant-side telemetry
    // to a third party is a privacy decision the app has not made, and Shopify
    // reviewers ask about any such call.
    console.error('CODkar admin crashed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;

    if (!error) return this.props.children;

    return (
      <Page title="CODkar">
        <Card>
          <BlockStack gap="400">
            <Banner tone="critical" title="Something went wrong">
              <p>
                The app hit an unexpected error and could not continue. Reloading usually
                clears it. If it keeps happening, send the details below to support.
              </p>
            </Banner>
            <Box background="bg-surface-secondary" padding="300" borderRadius="200">
              <Text as="p" variant="bodySm" breakWord>
                {error.message}
              </Text>
            </Box>
          </BlockStack>
        </Card>
      </Page>
    );
  }
}

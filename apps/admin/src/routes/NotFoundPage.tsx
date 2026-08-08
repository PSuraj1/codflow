import { EmptyState, Page } from '@shopify/polaris';
import { useNavigate } from 'react-router-dom';

/** Catch-all for client-side routes that do not exist. */
export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <Page>
      <EmptyState
        heading="Page not found"
        action={{ content: 'Back to CODkar', onAction: () => navigate('/') }}
        // Shopify's own illustration CDN, so the app ships no image assets of
        // its own for an error state most merchants will never see.
        image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
      >
        <p>The page you are looking for is not part of CODkar.</p>
      </EmptyState>
    </Page>
  );
}

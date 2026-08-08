import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@shopify/polaris/build/esm/styles.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PolarisProvider } from './providers/PolarisProvider';
import { QueryProvider } from './providers/QueryProvider';
import { isEmbedded } from './lib/appBridge';
import './styles.css';

/**
 * Admin entry point.
 *
 * Provider order is deliberate, and the ordering below is load-bearing rather
 * than cosmetic. The error boundary's fallback renders Polaris components, so
 * it has to sit *inside* `PolarisProvider`: with the boundary outermost, any
 * caught error made the fallback throw `MissingAppProviderError: No i18n was
 * provided` on its way to rendering, React tore down the tree, and the merchant
 * got a blank iframe instead of the error card — with the original error
 * reported nowhere. The router precedes Polaris because `PolarisProvider`
 * installs a link component that calls `useNavigate`.
 *
 * The trade is that a throw from `BrowserRouter` or `PolarisProvider`
 * themselves is no longer caught. Both are trivial and neither has ever thrown;
 * a fallback that cannot render is the worse failure by far.
 */

/**
 * Refuses to render outside the Shopify admin.
 *
 * An embedded app opened directly in a browser has no App Bridge, so every
 * request would fail on a missing session token and the merchant would see a
 * cascade of auth errors with no explanation. Detecting it up front and
 * offering the correct entry point is far more useful than rendering a shell
 * that cannot work.
 */
function renderStandaloneNotice(root: HTMLElement): void {
  const params = new URLSearchParams(window.location.search);
  const shop = params.get('shop');
  const installUrl = shop ? `/api/auth/install?shop=${encodeURIComponent(shop)}` : null;

  root.innerHTML = `
    <main style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                 max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6;">
      <h1 style="font-size: 1.5rem; margin-bottom: 0.5rem;">CODkar</h1>
      <p>This app runs inside the Shopify admin and cannot be opened directly.</p>
      ${
        installUrl
          ? `<p><a href="${installUrl}" style="color: #005bd3;">Open CODkar in your Shopify admin →</a></p>`
          : `<p>Open it from <strong>Apps</strong> in your Shopify admin.</p>`
      }
    </main>`;
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root element is missing from index.html');
}

if (!isEmbedded()) {
  renderStandaloneNotice(container);
} else {
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <PolarisProvider>
          <ErrorBoundary>
            <QueryProvider>
              <App />
            </QueryProvider>
          </ErrorBoundary>
        </PolarisProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

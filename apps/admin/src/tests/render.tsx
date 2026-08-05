import type { ReactElement, ReactNode } from 'react';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { render, type RenderResult } from '@testing-library/react';

/**
 * Renders a component inside the providers it expects.
 *
 * Polaris components read their translations from `AppProvider` context and
 * throw without it, so every component test needs this wrapper. Kept minimal —
 * the router and query client are added per test only where a component
 * actually needs them, rather than wrapping everything in machinery most tests
 * do not use.
 */
export function renderWithPolaris(ui: ReactElement): RenderResult {
  function Wrapper({ children }: { children: ReactNode }) {
    return <AppProvider i18n={enTranslations}>{children}</AppProvider>;
  }

  return render(ui, { wrapper: Wrapper });
}

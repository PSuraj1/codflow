import { type ReactNode, useCallback } from 'react';
import { AppProvider } from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import { useNavigate } from 'react-router-dom';

/**
 * Polaris root.
 *
 * The `linkComponent` override is the piece that is easy to miss and expensive
 * to omit. Polaris renders plain anchors by default; inside an embedded app a
 * plain anchor triggers a full document load *of the iframe*, which tears down
 * App Bridge and reloads the entire bundle. Routing those clicks through React
 * Router keeps navigation client-side, and lets external links behave normally.
 */

interface PolarisLinkProps {
  url: string;
  children?: ReactNode;
  external?: boolean;
  target?: string;
  [key: string]: unknown;
}

function AppLink({ children, url, external, target, ...rest }: PolarisLinkProps) {
  const navigate = useNavigate();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle modified clicks (new tab, download) and anything
      // aimed outside the app.
      if (external || target === '_blank' || target === '_top') return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      navigate(url);
    },
    [external, navigate, target, url],
  );

  const externalProps = external
    ? { target: target ?? '_blank', rel: 'noopener noreferrer' }
    : { ...(target ? { target } : {}) };

  return (
    <a href={url} onClick={handleClick} {...externalProps} {...rest}>
      {children}
    </a>
  );
}

export function PolarisProvider({ children }: { children: ReactNode }) {
  return (
    <AppProvider i18n={enTranslations} linkComponent={AppLink}>
      {children}
    </AppProvider>
  );
}

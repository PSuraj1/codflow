import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Vite config for the embedded admin SPA.
 *
 * The admin is served inside a Shopify admin iframe, so two things differ from
 * a stock SPA setup: the dev server must accept the Shopify tunnel host, and
 * the app is never allowed to frame-bust. Both are handled below.
 */
export default defineConfig(({ mode }) => {
  // Load every var (not just VITE_-prefixed) so the API key can be injected
  // into index.html without also exposing unrelated secrets to the bundle.
  /**
   * Loaded from the repository root, not the package directory.
   *
   * `loadEnv` resolves against the directory it is given, and `npm run
   * dev:admin` runs with the cwd set to `apps/admin` — so passing
   * `process.cwd()` found no `.env` and `SHOPIFY_API_KEY` came back empty. The
   * symptom is not an error: `index.html` gets an empty API key, App Bridge
   * fails to initialise, and the embedded admin renders a blank frame with
   * nothing in the console pointing at the cause.
   *
   * The root is two levels up from `apps/admin`, and `import.meta.dirname`
   * rather than the cwd so it holds however the build is invoked.
   */
  const env = loadEnv(mode, path.resolve(import.meta.dirname, '../..'), '');

  const apiKey = env.SHOPIFY_API_KEY ?? env.VITE_SHOPIFY_API_KEY ?? '';

  /**
   * Where merchants reach support.
   *
   * The app operator's own channel, identical for every merchant, so it is
   * build configuration rather than a database column — a per-shop setting
   * would invite a merchant to point their own support widget somewhere the
   * operator does not read.
   *
   * Empty by default, and the widget renders nothing when it is empty. A
   * support button that opens `https://t.me/` is worse than no button.
   */
  const supportTelegramUrl = env.SUPPORT_TELEGRAM_URL ?? '';

  /**
   * Where `/api` is proxied in development.
   *
   * `shopify app dev` chooses the backend's port at runtime and passes it as
   * `BACKEND_PORT` — it is not 3000 unless nothing else claimed that first.
   * Hardcoding 3000 makes every admin request 502 under the CLI while working
   * perfectly when the API is started by hand, which is a confusing pair of
   * symptoms to hold at once.
   */
  const apiTarget =
    env.API_URL ?? `http://localhost:${env.BACKEND_PORT ?? '3000'}`;

  /**
   * The CLI also assigns this process's own port and points the tunnel at it.
   * Listening on 5173 regardless would leave the tunnel pointing at nothing.
   */
  const port = Number(env.FRONTEND_PORT ?? env.PORT ?? 5173);

  return {
    plugins: [
      react(),
      {
        // Substitutes __SHOPIFY_API_KEY__ in index.html. Done as a plugin
        // rather than `define` because the token sits in HTML, not JS — and
        // because the Shopify CLI injects SHOPIFY_API_KEY without the `VITE_`
        // prefix Vite requires for automatic client exposure.
        name: 'codflow-html-env',
        transformIndexHtml(html: string) {
          return html.replace(/__SHOPIFY_API_KEY__/g, apiKey);
        },
      },
    ],

    define: {
      // Inlined at build time. `define` rather than `import.meta.env` because
      // the Shopify CLI injects variables without the `VITE_` prefix Vite
      // requires for automatic client exposure.
      __SUPPORT_TELEGRAM_URL__: JSON.stringify(supportTelegramUrl),
    },

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@codflow/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },

    server: {
      port,
      // Shopify's tunnel gives a different hostname on every `shopify app dev`
      // run. Vite blocks unknown hosts by default, which would show a blank
      // iframe with no obvious cause.
      allowedHosts: true,
      cors: true,
      /**
       * HMR only needs overriding when a tunnel is in front of it.
       *
       * Under `shopify app dev` the browser reaches Vite over HTTPS on 443, so
       * the websocket has to be told to use `wss` on that port rather than the
       * dev server's own. Applying that unconditionally breaks hot reload for
       * anyone opening `http://localhost:5173` directly — the client tries
       * `wss://localhost:443`, nothing is listening, and the console fills with
       * "failed to connect to websocket" while edits silently stop applying.
       *
       * The CLI's presence is the signal, and it is the same one
       * `withShopifyCliEnv` keys off in the API.
       */
      ...(env.SHOPIFY_APP_URL || env.HOST
        ? { hmr: { protocol: 'wss' as const, clientPort: 443 } }
        : {}),
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
        /*
         * The public legal pages, served by the API rather than the SPA.
         *
         * Without this they fall through to the catch-all that returns
         * index.html, so `/legal/privacy` renders the admin shell in
         * development and the actual policy in production — a difference that
         * only shows up when someone opens the URL they put on the App Store
         * listing.
         */
        '/legal': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
        /* The FAQ, for the same reason. Every root path the API serves needs an
         * entry here or it silently renders the admin shell in development. */
        '/help': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Shopify reviewers flag slow-loading embedded apps; keep an eye on this.
      chunkSizeWarningLimit: 900,
      sourcemap: mode !== 'production',
      rollupOptions: {
        output: {
          /**
           * Split the two heaviest, rarely-changing dependency groups so a code
           * change does not invalidate the whole vendor bundle in merchants'
           * caches.
           *
           * Rollup 4 (Vite 8) dropped the object form of `manualChunks` in
           * favour of a resolver function. Matching on the module id rather
           * than a package list also catches transitive imports — Polaris pulls
           * in its own icon and tokens packages, which the object form left in
           * the main bundle.
           */
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@shopify/polaris')) return 'polaris';
            if (/node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
              return 'react';
            }
            return undefined;
          },
        },
      },
    },

    // Polaris ships CSS with relative font URLs; ensure they resolve from root.
    base: '/',
  };
});

import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the theme app extension.
 *
 * Configured at the repository root rather than inside `extensions/` on
 * purpose: a theme app extension directory must not contain a `package.json`.
 * The Shopify CLI walks that directory when building and uploading the
 * extension, and an unexpected manifest there changes how it is treated.
 *
 * So the extension is not an npm workspace, `npm run test --workspaces` cannot
 * reach it, and the root exposes `npm run test:extension` instead — wired into
 * the root `test` script so it still runs as part of the whole suite.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the alias in the extension's tsconfig and the resolution
      // esbuild performs when bundling: tests exercise the same source the
      // shipped bundle contains, not a stale `dist`.
      '@codflow/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // The renderer builds real DOM nodes, so it needs a DOM.
    environment: 'jsdom',
    include: ['theme-src/src/**/*.test.ts'],
  },
});

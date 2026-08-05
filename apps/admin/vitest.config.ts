import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the embedded admin.
 *
 * Separate from `vite.config.ts` because that file loads the environment and
 * injects the Shopify API key into `index.html` — neither of which a component
 * test needs, and both of which would make the suite depend on a `.env`.
 *
 * `@codflow/shared` resolves to source rather than `dist`, so a contract change
 * shows up in these tests without a rebuild first.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@codflow/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/tests/setup.ts'],
  },
});

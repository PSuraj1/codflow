import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the API.
 *
 * `test.env` rather than a setup file, because `config/env` validates and
 * freezes the environment at *module load* — the first import of anything that
 * transitively reaches it. A setup file assigning `process.env` would race that
 * import and fail intermittently depending on module resolution order. Values
 * set here are in place before any module is evaluated.
 *
 * The values are deliberately fake but structurally valid: a 32-byte base64 key
 * that AES-256-GCM will accept, a 64-character session secret, and URLs that
 * parse. Tests that need a real database or Redis are the ones that do not
 * exist here — everything under test is either pure logic or exercised through
 * the HTTP surface with the dependency failure as the expected outcome.
 */
export default defineConfig({
  /**
   * `@codflow/shared` resolves to its **source**, not its build output.
   *
   * The package's `exports` point at `dist/`, which is gitignored — so on a
   * fresh checkout every test importing it failed with "Cannot find module"
   * until something had run the shared build first. That made `npm run test`
   * silently dependent on a leftover artifact, and it passed locally for
   * exactly that reason while failing in CI.
   *
   * Aliasing to source also means tests exercise the code as written rather
   * than a compiled copy of it. `apps/admin` has resolved it this way from the
   * start; this brings the two into line.
   */
  resolve: {
    alias: {
      '@codflow/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      APP_URL: 'https://codflow.test',
      SHOPIFY_API_KEY: 'test-api-key',
      SHOPIFY_API_SECRET: 'test-api-secret',
      SHOPIFY_SCOPES: 'read_products,write_orders,read_orders',
      SHOPIFY_API_VERSION: '2026-07',
      // Pinned so the managed-pricing URL assertion does not depend on whatever
      // handle the developer's own app happens to use.
      SHOPIFY_APP_HANDLE: 'codflow',
      DATABASE_URL: 'postgresql://codflow:codflow@127.0.0.1:5432/codflow_test',
      REDIS_URL: 'redis://127.0.0.1:6379',
      // 32 bytes of zeroes, base64. Valid key material, obviously not a secret.
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      SESSION_SECRET: 'a'.repeat(64),
      GOOGLE_CLIENT_ID: 'test-google-client',
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
      GOOGLE_REDIRECT_URI: 'https://codflow.test/api/google/callback',
      LOG_LEVEL: 'silent',
    },
    /**
     * One worker, forked.
     *
     * `redis/index.ts` opens three ioredis connections at import time and
     * `db/prisma.ts` builds a client. Parallel workers would each construct
     * their own set and spend the run retrying connections to a database that
     * is not there — noisy, slow, and with no upside for a suite this size.
     *
     * A forked worker is torn down by vitest when the run ends, so those
     * handles die with it and the process exits cleanly without an explicit
     * teardown. `poolOptions` was removed in Vitest 4; these are the top-level
     * replacements.
     */
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15_000,
  },
});

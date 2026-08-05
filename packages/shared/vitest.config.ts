import { defineConfig } from 'vitest/config';

/**
 * Tests for the shared package.
 *
 * These matter more than their size suggests: the validation engine here is the
 * *same code* the storefront, the admin preview and the API all run. A
 * regression in it does not break one surface, it breaks the agreement between
 * all three — a shopper passing every check in front of them and then being
 * rejected by the server with no way to see why.
 *
 * No environment setup, because nothing in this package reads one. That is
 * deliberate and worth preserving: the moment `@codflow/shared` needs a
 * variable, it stops being importable from the storefront bundle.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Fail on an unhandled rejection rather than letting it pass silently as a
    // green run.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});

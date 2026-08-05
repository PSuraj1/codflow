import path from 'node:path';
import { config as dotenv } from 'dotenv';

/**
 * Loads `.env` from the repository root, wherever the process was started from.
 *
 * `dotenv/config` — the one-line import — resolves against `process.cwd()`, and
 * almost nothing in this repository runs from the repository root:
 *
 *   npm run dev:api        cwd is apps/api  (npm workspace scripts)
 *   prisma migrate dev     cwd is apps/api
 *   tsx prisma/seed.ts     cwd is apps/api
 *   npm run release        cwd is the root
 *   the Docker image       cwd is /app, and there is no .env at all
 *
 * So the plain import silently found nothing in every ordinary case, while a
 * correctly filled `.env` sat one or two directories up. Each entry point then
 * failed differently and none of them named the file: the API exited with
 * "APP_URL is required", Prisma with "Environment variable not found:
 * DIRECT_DATABASE_URL" pointing at the schema, the seed with a validation error
 * from deep inside the client. Four symptoms, one cause.
 *
 * This exists as its own module — rather than living in `config/env` — because
 * two of those callers deliberately avoid importing `config/env`. The seed and
 * the preflight script both need a database URL and neither can tolerate a
 * module that exits the process when the environment is incomplete.
 *
 * dotenv keeps the first value it finds for a key and never overwrites a
 * variable that is already set, so a real environment — a container, or the
 * Shopify CLI injecting its own — always wins over a file.
 *
 * **Never under test.** `vitest.config.ts` supplies a complete, fixed
 * environment through `test.env`, and any key it does not set would otherwise be
 * filled in from whatever happens to be in the developer's `.env` — so a test
 * would pass or fail depending on a file that is not in the repository. That is
 * not hypothetical: changing `SHOPIFY_APP_HANDLE` locally broke a billing test
 * that had never been touched, because the suite silently read the real value
 * instead of the fixture's.
 */
export function loadRootEnv(): void {
  if (process.env.NODE_ENV === 'test') return;

  dotenv({
    path: [
      // Started from the repository root.
      path.resolve(process.cwd(), '.env'),
      // Started from a workspace package: apps/api, apps/admin, packages/shared.
      path.resolve(process.cwd(), '../../.env'),
    ],
    quiet: true,
  });
}

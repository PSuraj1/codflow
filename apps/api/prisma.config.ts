import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadRootEnv } from './src/lib/loadDotenv';

/**
 * Prisma CLI configuration.
 *
 * Replaces the `package.json#prisma` key, which is deprecated in Prisma 6 and
 * removed in 7. The datasource URL still lives in schema.prisma under Prisma 6 —
 * moving it here is a Prisma 7 requirement, not a 6.x one.
 *
 * Prisma does not auto-load .env when a config file is present — it reports
 * "Prisma config detected, skipping environment variable loading" — so this call
 * is what keeps migrate and seed working at all. See `loadDotenv` for why the
 * plain `dotenv/config` import was not enough.
 *
 * Note there is no `earlyAccess` key — that was required while prisma.config.ts
 * was experimental and is rejected by the strict config validator in 6.19.
 */
loadRootEnv();

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});

/**
 * Preflight — everything that must be true before `shopify app dev` works.
 *
 * Each check corresponds to a failure that is otherwise diagnosed by staring at
 * a blank iframe or an OAuth error that names nothing useful. They are cheap,
 * they run in one command, and they report the *fix* rather than the symptom:
 *
 *   - .env not being read          -> every variable reads as undefined
 *   - Postgres unreachable         -> the API exits at boot, before logging
 *   - Migrations not applied       -> every query fails on a missing table
 *   - Redis evicting               -> BullMQ loses jobs silently, no error
 *   - API key != client_id         -> install loops through consent forever
 *   - APP_URL != application_url   -> OAuth rejects the redirect
 *
 * The last two are worth the most: nothing in the running app can detect them,
 * and both present to the merchant as "the app is broken".
 *
 * **This script deliberately shares nothing with the running app.** It reads
 * `process.env` directly and builds its own Postgres and Redis clients, because
 * every module that would otherwise provide them imports `config/env` — which
 * exits the process on an invalid environment. That is precisely the state this
 * tool exists to diagnose, so depending on it would mean the diagnostic only
 * runs once there is nothing left to diagnose.
 *
 *   npm run preflight
 */

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { config as loadDotenv } from 'dotenv';

// The same two locations `config/env` looks in, in the same order: npm
// workspace scripts run with the cwd set to their own package, so the root
// `.env` the README describes is one directory up from there.
const ROOT = path.resolve(__dirname, '../../../..');

loadDotenv({ path: [path.resolve(process.cwd(), '.env'), path.join(ROOT, '.env')], quiet: true });

type Status = 'pass' | 'warn' | 'fail';

interface Result {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  /** What to do about it. Only shown when the check did not pass. */
  readonly fix?: string;
}

const results: Result[] = [];
const record = (result: Result): void => void results.push(result);

/**
 * The first line of an error that actually says something.
 *
 * Prisma opens its connection errors with a blank line and a banner, so naively
 * taking `split('\n')[0]` reports an empty string — a failure row with no
 * reason on it, which is worse than no row at all.
 */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'unreachable'
  );
}

/** Blank means unset, matching how `config/env` normalises the environment. */
function value(key: string): string | null {
  const raw = process.env[key];
  return raw && raw.trim() !== '' ? raw.trim() : null;
}

// ---------------------------------------------------------------------------
// Environment file
// ---------------------------------------------------------------------------

const REQUIRED = [
  'APP_URL',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_SCOPES',
  'DATABASE_URL',
  'REDIS_URL',
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
] as const;

function checkEnvFile(): string[] {
  const rootEnv = path.join(ROOT, '.env');

  if (!fs.existsSync(rootEnv)) {
    record({
      name: '.env',
      status: 'fail',
      detail: 'not found at the repository root',
      fix: 'cp .env.example .env',
    });
  } else {
    record({ name: '.env', status: 'pass', detail: rootEnv });
  }

  const missing = REQUIRED.filter((key) => value(key) === null);

  if (missing.length > 0) {
    record({
      name: 'Required values',
      status: 'fail',
      detail: `${missing.join(', ')} not set`,
      fix: 'Fill these in .env — the API refuses to boot without them',
    });
  } else {
    record({ name: 'Required values', status: 'pass', detail: `all ${REQUIRED.length} present` });
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Shopify configuration
// ---------------------------------------------------------------------------

/** Reads one top-level key out of shopify.app.toml without a TOML parser. */
function tomlValue(source: string, key: string): string | null {
  return new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(source)?.[1] ?? null;
}

function checkShopifyConfig(): void {
  const tomlPath = path.join(ROOT, 'shopify.app.toml');

  if (!fs.existsSync(tomlPath)) {
    record({
      name: 'shopify.app.toml',
      status: 'fail',
      detail: 'not found',
      fix: 'shopify app config link',
    });
    return;
  }

  const toml = fs.readFileSync(tomlPath, 'utf8');
  const clientId = tomlValue(toml, 'client_id');
  const applicationUrl = tomlValue(toml, 'application_url');
  const handle = tomlValue(toml, 'handle');
  const apiKey = value('SHOPIFY_API_KEY');

  const linked = Boolean(clientId && !clientId.startsWith('REPLACE'));

  record(
    linked
      ? { name: 'App linked', status: 'pass', detail: clientId as string }
      : {
          name: 'App linked',
          status: 'fail',
          detail: 'client_id is still the placeholder',
          fix: 'shopify app config link',
        },
  );

  // A mismatch here makes managed installation loop: Shopify grants for one
  // app while the API validates session tokens against another, so the merchant
  // consents, returns, and is sent straight back to consent.
  if (!apiKey) {
    record({
      name: 'SHOPIFY_API_KEY',
      status: 'fail',
      detail: 'not set',
      fix: 'Partner Dashboard -> your app -> Client credentials',
    });
  } else if (!linked) {
    // Nothing to compare against yet. Reporting a pass here would claim a match
    // that was never checked — and this is the one check whose whole value is
    // the comparison, so a false green defeats the point of running it.
    record({
      name: 'SHOPIFY_API_KEY',
      status: 'warn',
      detail: 'set, but cannot be verified until the app is linked',
      fix: 'shopify app config link, then run this again',
    });
  } else if (apiKey !== clientId) {
    record({
      name: 'SHOPIFY_API_KEY',
      status: 'fail',
      detail: 'does not match client_id in shopify.app.toml',
      fix: `Set SHOPIFY_API_KEY=${clientId}`,
    });
  } else {
    record({ name: 'SHOPIFY_API_KEY', status: 'pass', detail: 'matches client_id' });
  }

  record(
    value('SHOPIFY_API_SECRET')
      ? { name: 'SHOPIFY_API_SECRET', status: 'pass', detail: 'set' }
      : {
          name: 'SHOPIFY_API_SECRET',
          status: 'fail',
          detail: 'not set',
          // Without it every webhook fails HMAC verification with a 401 that
          // looks like Shopify's problem rather than a missing value.
          fix: 'Partner Dashboard -> your app -> Client credentials',
        },
  );

  // ---- Scopes must match the TOML exactly, or the app asks for consent it has
  const tomlScopes = /scopes\s*=\s*"([^"]*)"/.exec(toml)?.[1];
  const envScopes = value('SHOPIFY_SCOPES');

  if (tomlScopes && envScopes) {
    const fromToml = tomlScopes.split(',').map((scope) => scope.trim()).sort().join(',');
    const fromEnv = envScopes.split(',').map((scope) => scope.trim()).sort().join(',');

    record(
      fromToml === fromEnv
        ? { name: 'Scopes', status: 'pass', detail: `${fromEnv.split(',').length} declared` }
        : {
            name: 'Scopes',
            status: 'fail',
            detail: 'SHOPIFY_SCOPES differs from access_scopes in shopify.app.toml',
            fix: `Set SHOPIFY_SCOPES=${tomlScopes}`,
          },
    );
  }

  const appHandle = value('SHOPIFY_APP_HANDLE') ?? 'codflow';

  record(
    handle && handle !== appHandle
      ? {
          name: 'App handle',
          status: 'warn',
          detail: `.env says "${appHandle}", the toml says "${handle}"`,
          fix: `Set SHOPIFY_APP_HANDLE=${handle} — otherwise the upgrade button 404s`,
        }
      : { name: 'App handle', status: 'pass', detail: appHandle },
  );

  // ---- APP_URL against application_url.
  //
  // Only meaningful when the CLI is not running: `shopify app dev` rewrites
  // both on every run, so a mismatch beforehand is expected and reporting it
  // would be noise.
  const appUrl = value('APP_URL');
  const cliRunning = Boolean(process.env.SHOPIFY_APP_URL ?? process.env.HOST);

  if (cliRunning) {
    record({ name: 'APP_URL', status: 'pass', detail: 'managed by the Shopify CLI for this run' });
  } else if (appUrl && applicationUrl && applicationUrl !== appUrl) {
    const placeholder =
      applicationUrl.includes('example.com') || appUrl.includes('your-tunnel');

    record({
      name: 'APP_URL',
      status: placeholder ? 'warn' : 'fail',
      detail: `.env has ${appUrl}, the toml has ${applicationUrl}`,
      fix: placeholder
        ? '`npm run dev` sets both — only fix this by hand if you use your own tunnel'
        : 'They must match exactly, or Shopify rejects the OAuth redirect',
    });
  } else if (appUrl) {
    record({ name: 'APP_URL', status: 'pass', detail: appUrl });
  }

  checkGoogleRedirect(appUrl);
}

/**
 * Google Sheets credentials, and the redirect URI in particular.
 *
 * The redirect URI is the one piece of this app's configuration that lives in
 * *three* places at once: `.env`, the Google Cloud console's authorised list,
 * and — because it embeds the tunnel hostname — a value that changes on every
 * `shopify app dev` run. Get it wrong and Google answers `redirect_uri_mismatch`
 * on a page of its own, mid-OAuth, saying nothing about tunnels. That is a long
 * afternoon for anyone who has not hit it before.
 *
 * The credentials being absent is reported as information rather than a
 * problem: Sheets is optional, the app runs without it, and the connect button
 * already says so.
 */
function checkGoogleRedirect(appUrl: string | null): void {
  const clientId = value('GOOGLE_CLIENT_ID');
  const clientSecret = value('GOOGLE_CLIENT_SECRET');
  const redirectUri = value('GOOGLE_REDIRECT_URI');

  if (!clientId || !clientSecret) {
    record({
      name: 'Google Sheets',
      status: 'pass',
      detail: 'not configured — the feature reports itself as off',
    });
    return;
  }

  if (!redirectUri) {
    record({
      name: 'Google redirect',
      status: 'fail',
      detail: 'GOOGLE_CLIENT_ID is set but GOOGLE_REDIRECT_URI is empty',
      fix: 'Set it to <your app URL>/api/google/callback, and add the same value in Google Cloud',
    });
    return;
  }

  // Under the CLI the tunnel is whatever it assigned this run, so that is what
  // the redirect has to match — not the stale value sitting in `.env`.
  const effectiveAppUrl = process.env.SHOPIFY_APP_URL ?? process.env.HOST ?? appUrl;

  if (!effectiveAppUrl) {
    record({ name: 'Google redirect', status: 'pass', detail: redirectUri });
    return;
  }

  const expected = `${effectiveAppUrl.replace(/\/$/, '')}/api/google/callback`;

  record(
    redirectUri === expected
      ? { name: 'Google redirect', status: 'pass', detail: redirectUri }
      : {
          name: 'Google redirect',
          status: 'warn',
          detail: `GOOGLE_REDIRECT_URI is ${redirectUri}, this run serves ${expected}`,
          fix: 'Google rejects the sign-in with redirect_uri_mismatch. Update .env and the authorised redirect URI in Google Cloud — the tunnel changes every `shopify app dev` run, so a stable tunnel is worth it here',
        },
  );
}

// ---------------------------------------------------------------------------
// Data stores
// ---------------------------------------------------------------------------

/** True when a URL points at this machine rather than a hosted service. */
function isLocal(url: string): boolean {
  return /(localhost|127\.0\.0\.1|\[::1\])/.test(url);
}

/**
 * What to tell someone whose data store did not answer.
 *
 * The advice differs completely by cause, and the URL says which. A local URL
 * that refuses the connection means nothing is running — the fix is one command,
 * and no amount of staring at a Prisma stack trace suggests it. A hosted URL
 * that fails is almost always TLS or a firewall, and telling that person to run
 * `docker compose up` would send them somewhere useless.
 */
function unreachableFix(url: string, service: 'postgres' | 'redis'): string {
  if (isLocal(url)) {
    const port = service === 'postgres' ? '5432' : '6379';
    return `Nothing is listening on localhost:${port}. Start it with: docker compose up -d`;
  }

  return service === 'postgres'
    ? 'Check DATABASE_URL. Hosted Postgres usually needs ?sslmode=require'
    : 'Check REDIS_URL. Upstash needs the rediss:// form, and ?family=0 in some regions';
}

async function checkPostgres(url: string): Promise<void> {
  // Its own client, pointed straight at the URL under test. `db/prisma` would
  // be the obvious thing to reuse and cannot be — see the note at the top.
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    await prisma.$queryRaw`SELECT 1`;
    record({ name: 'PostgreSQL', status: 'pass', detail: 'reachable' });
  } catch (error) {
    record({
      name: 'PostgreSQL',
      status: 'fail',
      detail: firstLine(error),
      fix: unreachableFix(url, 'postgres'),
    });

    await prisma.$disconnect().catch(() => undefined);
    return;
  }

  // A reachable database with no schema is the more confusing failure: the app
  // boots happily and then every request fails on a missing table.
  try {
    const applied = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;

    const count = Number(applied[0]?.count ?? 0);
    const onDisk = fs
      .readdirSync(path.resolve(__dirname, '../../prisma/migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;

    record(
      count >= onDisk && count > 0
        ? { name: 'Migrations', status: 'pass', detail: `${count} of ${onDisk} applied` }
        : {
            name: 'Migrations',
            status: 'fail',
            detail: count === 0 ? 'none applied' : `${count} of ${onDisk} applied`,
            fix: 'npm run prisma:migrate',
          },
    );
  } catch {
    record({
      name: 'Migrations',
      status: 'fail',
      detail: 'the migrations table does not exist',
      fix: 'npm run prisma:migrate',
    });
  }

  await prisma.$disconnect().catch(() => undefined);
}

async function checkRedis(url: string): Promise<void> {
  const redis = new Redis(url, {
    // Fail rather than sit in ioredis's reconnect loop: this is a diagnostic,
    // and "cannot connect" is the answer it is here to give.
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 8_000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    await redis.ping();
    record({ name: 'Redis', status: 'pass', detail: 'reachable' });
  } catch (error) {
    record({
      name: 'Redis',
      status: 'fail',
      detail: firstLine(error),
      fix: unreachableFix(url, 'redis'),
    });

    redis.disconnect();
    return;
  }

  /**
   * BullMQ keeps job state in Redis. A key dropped by an LRU policy is work
   * that silently never happens — an order that never reaches Shopify, with
   * nothing anywhere recording the loss.
   *
   * Managed Redis often refuses `CONFIG GET`, so an error is not a failure; it
   * means the setting has to be confirmed in the provider's own dashboard.
   */
  try {
    const policy = await redis.config('GET', 'maxmemory-policy');
    const setting = Array.isArray(policy) ? String(policy[1]) : '';

    record(
      !setting || setting === 'noeviction'
        ? { name: 'Redis eviction', status: 'pass', detail: setting || 'noeviction' }
        : {
            name: 'Redis eviction',
            status: 'fail',
            detail: `maxmemory-policy is ${setting}`,
            fix: 'Set it to noeviction — BullMQ loses jobs silently under any LRU policy',
          },
    );
  } catch {
    record({
      name: 'Redis eviction',
      status: 'warn',
      detail: 'the provider does not allow CONFIG GET',
      fix: 'Confirm maxmemory-policy is noeviction in your provider dashboard',
    });
  }

  redis.disconnect();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(): number {
  const width = Math.max(...results.map((result) => result.name.length));

  process.stdout.write('\nCodFlow preflight\n\n');

  for (const result of results) {
    const icon = result.status === 'pass' ? ' ok ' : result.status === 'warn' ? 'warn' : 'FAIL';
    process.stdout.write(`  [${icon}]  ${result.name.padEnd(width)}   ${result.detail}\n`);

    if (result.fix && result.status !== 'pass') {
      process.stdout.write(`${' '.repeat(width + 11)}-> ${result.fix}\n`);
    }
  }

  const failures = results.filter((result) => result.status === 'fail').length;
  const warnings = results.filter((result) => result.status === 'warn').length;

  process.stdout.write(
    failures === 0
      ? `\nReady${warnings > 0 ? ` — ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}. Next: npm run dev\n\n`
      : `\n${failures} problem${failures === 1 ? '' : 's'} to fix.\n\n`,
  );

  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const missing = checkEnvFile();
  checkShopifyConfig();

  // Connectivity is checked whenever a URL exists, regardless of what else is
  // missing — a half-filled `.env` is the normal state during setup, and
  // "Postgres is fine, you still need the API key" is a far more useful report
  // than refusing to look.
  const databaseUrl = value('DATABASE_URL');
  const redisUrl = value('REDIS_URL');

  if (databaseUrl) await checkPostgres(databaseUrl);
  if (redisUrl) await checkRedis(redisUrl);

  process.exit(report());
}

void main();

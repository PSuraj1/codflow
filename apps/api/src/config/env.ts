import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { loadRootEnv } from '../lib/loadDotenv';

// Before anything reads `process.env`. See `loadDotenv` for why the plain
// `dotenv/config` import does not work in this repository.
loadRootEnv();

/**
 * Environment parsing and validation.
 *
 * The process refuses to boot on an invalid environment rather than failing
 * later at the first request that happens to need a missing value. A COD app
 * holds merchant OAuth tokens and shopper PII, so "started but misconfigured"
 * is a worse outcome than "did not start".
 *
 * Import `config` (grouped) in application code; `env` (flat) exists for the
 * rare case where a raw value is needed.
 */

/** AES-256-GCM needs exactly 32 raw bytes of key material. */
const base64Key32 = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be 32 bytes base64-encoded — generate with: openssl rand -base64 32' },
  );

/**
 * Accepts "true"/"false"/"1"/"0" as well as real booleans, because values that
 * arrive from a shell, a .env file and a Docker env var are all strings.
 */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const EnvSchema = z.object({
  // ---- Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_URL: z.url({ message: 'APP_URL must be an absolute URL, e.g. https://app.example.com' }),
  ADMIN_ORIGIN: z.url().optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // ---- Shopify
  SHOPIFY_API_KEY: z.string().min(1),
  SHOPIFY_API_SECRET: z.string().min(1),
  SHOPIFY_SCOPES: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().min(1).default('2026-07'),
  /**
   * The app's handle, as set in shopify.app.toml.
   *
   * Only used to build the managed-pricing URL
   * (`/store/<shop>/charges/<app-handle>/pricing_plans`). A wrong value here
   * produces a Shopify 404 on the upgrade button rather than an error the app
   * could detect, which is why it is validated as non-empty rather than left to
   * a fallback at the call site.
   */
  SHOPIFY_APP_HANDLE: z.string().min(1).default('codflow'),

  /**
   * Shops that ignore plan limits entirely, as a comma-separated list of
   * myshopify domains.
   *
   * For the shops the app's own operator runs. A public app bills every
   * merchant, including its author, and a founder hitting the Free tier's
   * fifty-order ceiling on their own store is not a billing event anyone wants.
   *
   * Deliberately environment rather than a database column: an override written
   * as a row is lost the next time the database is rebuilt — which has already
   * happened to this project once — and a column that grants unlimited
   * entitlements is a column a compromised admin session can set.
   */
  PLAN_EXEMPT_SHOPS: z.string().default(''),

  // ---- Partner API. Only required once billing is switched on (Phase 9), so
  // these stay optional and are checked at the point of use.
  SHOPIFY_PARTNER_API_TOKEN: z.string().optional(),
  SHOPIFY_PARTNER_ORGANIZATION_ID: z.string().optional(),
  SHOPIFY_APP_ID: z.string().optional(),

  // ---- Data stores
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().min(1),
  REDIS_PREFIX: z.string().default('codflow'),

  // ---- Secrets
  ENCRYPTION_KEY: base64Key32,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  // ---- Google (Phase 5)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.url().optional(),

  // ---- Mail
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('CODkar'),
  MAIL_FROM_ADDRESS: z.email().optional(),

  // ---- Optional integrations
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  IP_INTEL_PROVIDER: z.enum(['ipqualityscore', 'ipapi', 'proxycheck']).optional(),
  IP_INTEL_API_KEY: z.string().optional(),

  // ---- Rate limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_ADMIN: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_MAX_STOREFRONT: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MAX_OTP: z.coerce.number().int().positive().default(5),

  // ---- Queue
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(10),
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  QUEUE_BACKOFF_MS: z.coerce.number().int().positive().default(5_000),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Reconciles the Shopify CLI's variable names with this app's.
 *
 * `shopify app dev` starts each web process itself and injects its own
 * environment, using names that predate this app: `SHOPIFY_APP_URL` for the
 * tunnel it just created, and `SCOPES` for the access scopes it read from
 * shopify.app.toml. Without this mapping the API refuses to boot under the CLI
 * with "APP_URL is required", which reads as a broken app rather than a naming
 * difference.
 *
 * **The CLI's value wins when it is present**, and that direction matters. The
 * tunnel hostname changes on every `shopify app dev` run, so a stale `APP_URL`
 * left in `.env` from yesterday's session would be used to build OAuth
 * redirects that Shopify then rejects — an error that names neither the stale
 * value nor the file it came from. If the CLI set it, the CLI owns it.
 *
 * When the CLI is not running, nothing here applies and `.env` is authoritative
 * as usual. That is the stable-tunnel workflow in DEPLOYMENT.md.
 */
/**
 * Treats a blank variable as absent.
 *
 * `.env.example` ships every optional key present and empty, which is the right
 * way to document them — a reader can see what exists without consulting the
 * schema. But an empty string is not `undefined`, so `z.enum([...]).optional()`
 * rejects it, and copying the template verbatim fails validation on a variable
 * the user never intended to set. `IP_INTEL_PROVIDER=` was the live example.
 *
 * Nothing in this app gives an empty string a meaning distinct from "unset" —
 * every optional value either has a default or disables a feature by its
 * absence — so collapsing the two is safe and removes a whole class of
 * confusing boot failures.
 */
export function withoutBlankValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value;
  }

  return cleaned;
}

export function withShopifyCliEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...source };

  // `HOST` is the CLI's older name for the same thing; still emitted by some
  // versions, and harmless to accept.
  const tunnelUrl = source.SHOPIFY_APP_URL ?? source.HOST;
  if (tunnelUrl) merged.APP_URL = tunnelUrl;

  if (source.SCOPES) merged.SHOPIFY_SCOPES = source.SCOPES;

  return merged;
}

/**
 * Values that are fine in development and dangerous in production.
 *
 * The schema above validates *shape*; this validates *fitness to deploy*. Every
 * check here catches a mistake a container would otherwise start up with
 * cheerfully, and only reveal later in a way that looks like something else:
 *
 *  - The example encryption key ships in `.env.example`. A production shop
 *    whose Google refresh tokens are encrypted with a publicly known key is a
 *    breach that no log line would ever mention.
 *  - An `http://` app URL breaks Shopify's embedding outright — the admin
 *    iframe silently refuses to load, which reads as "the app is broken".
 *  - A `localhost` database or Redis URL inside a container means the app is
 *    talking to itself. It boots, passes its own dependency check against
 *    nothing, and fails on the first real request.
 *
 * Failing at boot turns each of these into a deploy that never goes live, which
 * every platform reports loudly — rather than a running app that is quietly
 * wrong.
 */
export function productionProblems(candidate: Env): string[] {
  if (candidate.NODE_ENV !== 'production') return [];

  const problems: string[] = [];

  // 32 zero bytes, base64 — the value in .env.example.
  if (candidate.ENCRYPTION_KEY === 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') {
    problems.push(
      'ENCRYPTION_KEY is the example key from .env.example. Generate one with: openssl rand -base64 32',
    );
  }

  // Catches the `'a'.repeat(64)` placeholder and anything equally lazy.
  if (/^(.)\1+$/.test(candidate.SESSION_SECRET)) {
    problems.push('SESSION_SECRET is a repeated character. Generate one with: openssl rand -hex 32');
  }

  if (!candidate.APP_URL.startsWith('https://')) {
    problems.push('APP_URL must be https in production — Shopify refuses to embed an http app');
  }

  if (candidate.APP_URL.includes('example.com')) {
    problems.push('APP_URL is still the placeholder from .env.example');
  }

  for (const [name, value] of [
    ['DATABASE_URL', candidate.DATABASE_URL],
    ['REDIS_URL', candidate.REDIS_URL],
  ] as const) {
    if (/(localhost|127\.0\.0\.1)/.test(value)) {
      problems.push(`${name} points at localhost, which inside a container means the container itself`);
    }
  }

  return problems;
}

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(withShopifyCliEnv(withoutBlankValues(process.env)));

  if (!parsed.success) {
    // Cannot use the app logger here — it depends on this module.
    process.stderr.write(
      `\nInvalid environment configuration:\n\n${z.prettifyError(parsed.error)}\n\n` +
        `Copy .env.example to .env and fill in the missing values.\n\n`,
    );
    process.exit(1);
  }

  const problems = productionProblems(parsed.data);

  if (problems.length > 0) {
    process.stderr.write(
      `\nUnsafe production configuration:\n\n` +
        problems.map((problem) => `  - ${problem}`).join('\n') +
        `\n\nRefusing to start. See DEPLOYMENT.md.\n\n`,
    );
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = loadEnv();

const isProduction = env.NODE_ENV === 'production';

/**
 * Grouped view of the environment. Prefer this over `env` — it keeps call sites
 * readable and gives each subsystem an obvious surface.
 */
export const config = {
  env: env.NODE_ENV,
  isProduction,
  isDevelopment: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',

  server: {
    port: env.PORT,
    appUrl: env.APP_URL.replace(/\/$/, ''),
    // Host without protocol — required by shopifyApi's `hostName`.
    hostName: new URL(env.APP_URL).host,
    adminOrigin: env.ADMIN_ORIGIN,
    logLevel: env.LOG_LEVEL,
  },

  shopify: {
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET,
    scopes: env.SHOPIFY_SCOPES.split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
    apiVersion: env.SHOPIFY_API_VERSION,
    appHandle: env.SHOPIFY_APP_HANDLE,
  },

  billing: {
    /** Lower-cased so a domain typed with capitals still matches. */
    exemptShops: env.PLAN_EXEMPT_SHOPS.split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  },

  partner: {
    token: env.SHOPIFY_PARTNER_API_TOKEN,
    organizationId: env.SHOPIFY_PARTNER_ORGANIZATION_ID,
    appId: env.SHOPIFY_APP_ID,
    /** Billing reconciliation is only possible when all three are present. */
    isConfigured: Boolean(
      env.SHOPIFY_PARTNER_API_TOKEN &&
        env.SHOPIFY_PARTNER_ORGANIZATION_ID &&
        env.SHOPIFY_APP_ID,
    ),
  },

  database: {
    url: env.DATABASE_URL,
    directUrl: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL,
  },

  redis: {
    url: env.REDIS_URL,
    prefix: env.REDIS_PREFIX,
  },

  security: {
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'base64'),
    sessionSecret: env.SESSION_SECRET,
  },

  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
    isConfigured: Boolean(
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI,
    ),
  },

  mail: {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    fromName: env.MAIL_FROM_NAME,
    fromAddress: env.MAIL_FROM_ADDRESS,
    isConfigured: Boolean(env.SMTP_HOST && env.MAIL_FROM_ADDRESS),
  },

  ipIntel: {
    provider: env.IP_INTEL_PROVIDER,
    apiKey: env.IP_INTEL_API_KEY,
    isConfigured: Boolean(env.IP_INTEL_PROVIDER && env.IP_INTEL_API_KEY),
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    maxAdmin: env.RATE_LIMIT_MAX_ADMIN,
    maxStorefront: env.RATE_LIMIT_MAX_STOREFRONT,
    maxOtp: env.RATE_LIMIT_MAX_OTP,
  },

  queue: {
    concurrency: env.QUEUE_CONCURRENCY,
    maxAttempts: env.QUEUE_MAX_ATTEMPTS,
    backoffMs: env.QUEUE_BACKOFF_MS,
  },
} as const;

export type Config = typeof config;

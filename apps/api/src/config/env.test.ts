import { describe, expect, it } from 'vitest';
import {
  productionProblems,
  withShopifyCliEnv,
  withoutBlankValues,
  type Env,
} from './env';

/**
 * Production boot guards.
 *
 * These are the last check between a mistyped environment variable and a live
 * deploy, and every case below is a failure that a running app would otherwise
 * hide rather than report: tokens encrypted with a public key, an iframe that
 * refuses to load, a process talking to itself.
 *
 * The guard has to be exactly as strict as it is and no stricter — a false
 * positive here blocks a legitimate deploy at the worst possible moment, so the
 * development cases matter as much as the production ones.
 */

function env(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'production',
    APP_URL: 'https://codflow.app',
    DATABASE_URL: 'postgresql://user:pass@db.internal:5432/codflow',
    REDIS_URL: 'redis://cache.internal:6379',
    ENCRYPTION_KEY: 'Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE=',
    SESSION_SECRET: '9f2c4a7e1b8d3f6a2c5e9b1d4f7a3c6e8b2d5f9a1c4e7b3d6f8a2c5e9b1d4f7a',
    ...overrides,
  } as Env;
}

describe('withoutBlankValues', () => {
  it('drops a blank optional variable so `.optional()` applies to it', () => {
    // The live bug: `.env.example` ships IP_INTEL_PROVIDER= to document that it
    // exists, and `z.enum([...]).optional()` rejects the empty string — so
    // copying the template verbatim failed to boot on a value nobody set.
    const cleaned = withoutBlankValues({ IP_INTEL_PROVIDER: '', SHOPIFY_API_KEY: 'real' });

    expect(cleaned).not.toHaveProperty('IP_INTEL_PROVIDER');
    expect(cleaned.SHOPIFY_API_KEY).toBe('real');
  });

  it('treats whitespace as blank', () => {
    expect(withoutBlankValues({ GOOGLE_CLIENT_ID: '   ' })).not.toHaveProperty('GOOGLE_CLIENT_ID');
  });

  it('keeps values that only look empty', () => {
    // "0" and "false" are meaningful; only an empty string means "unset".
    const cleaned = withoutBlankValues({ SMTP_SECURE: 'false', RATE_LIMIT_MAX_OTP: '0' });

    expect(cleaned).toEqual({ SMTP_SECURE: 'false', RATE_LIMIT_MAX_OTP: '0' });
  });
});

describe('withShopifyCliEnv', () => {
  it('maps the CLI’s names onto the ones this app validates', () => {
    const merged = withShopifyCliEnv({
      SHOPIFY_APP_URL: 'https://abc-123.trycloudflare.com',
      SCOPES: 'read_products,write_orders',
    });

    // Without this the API refuses to boot under `shopify app dev` with
    // "APP_URL is required", which reads as a broken app rather than a naming
    // difference.
    expect(merged.APP_URL).toBe('https://abc-123.trycloudflare.com');
    expect(merged.SHOPIFY_SCOPES).toBe('read_products,write_orders');
  });

  it('lets the CLI override a stale value left in .env', () => {
    // The tunnel hostname changes on every run. Preferring `.env` here would
    // build OAuth redirects Shopify rejects, naming neither the stale value nor
    // the file it came from.
    const merged = withShopifyCliEnv({
      APP_URL: 'https://yesterdays-tunnel.trycloudflare.com',
      SHOPIFY_APP_URL: 'https://todays-tunnel.trycloudflare.com',
    });

    expect(merged.APP_URL).toBe('https://todays-tunnel.trycloudflare.com');
  });

  it('accepts the CLI’s older HOST spelling', () => {
    expect(withShopifyCliEnv({ HOST: 'https://abc.trycloudflare.com' }).APP_URL).toBe(
      'https://abc.trycloudflare.com',
    );

    // `SHOPIFY_APP_URL` is the current name and wins where both are present.
    expect(
      withShopifyCliEnv({
        HOST: 'https://old.trycloudflare.com',
        SHOPIFY_APP_URL: 'https://new.trycloudflare.com',
      }).APP_URL,
    ).toBe('https://new.trycloudflare.com');
  });

  it('leaves a hand-run environment completely alone', () => {
    // The stable-tunnel workflow: no CLI, so `.env` stays authoritative.
    const source = { APP_URL: 'https://codflow.app', SHOPIFY_SCOPES: 'read_products' };

    expect(withShopifyCliEnv(source)).toEqual(source);
  });

  it('does not mutate the environment it was given', () => {
    const source = { SHOPIFY_APP_URL: 'https://abc.trycloudflare.com' };
    withShopifyCliEnv(source);

    expect(source).not.toHaveProperty('APP_URL');
  });
});

describe('productionProblems', () => {
  it('passes a correctly configured production environment', () => {
    expect(productionProblems(env())).toEqual([]);
  });

  it('says nothing at all outside production', () => {
    // Development runs on exactly these values by design — .env.example ships
    // them. Complaining would make every local boot noisy for no benefit.
    const development = env({
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://codflow:codflow@localhost:5432/codflow',
      REDIS_URL: 'redis://127.0.0.1:6379',
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      SESSION_SECRET: 'a'.repeat(64),
    });

    expect(productionProblems(development)).toEqual([]);
  });

  it('rejects the example encryption key', () => {
    // The one that would never show up in a log: a shop whose Google refresh
    // tokens are encrypted with a key published in this repository.
    const problems = productionProblems(
      env({ ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ENCRYPTION_KEY/);
    // The message carries the fix, not just the complaint.
    expect(problems[0]).toMatch(/openssl rand -base64 32/);
  });

  it('rejects a placeholder session secret', () => {
    expect(productionProblems(env({ SESSION_SECRET: 'a'.repeat(64) }))).toHaveLength(1);
  });

  it('accepts a real random secret that happens to repeat a character', () => {
    // `^(.)\1+$` matches only a string that is *entirely* one character. A
    // guard that rejected any repetition would fail on legitimate keys.
    expect(productionProblems(env({ SESSION_SECRET: `aa${'9f2c4a7e1b8d3f6a'.repeat(4)}` }))).toEqual(
      [],
    );
  });

  it('rejects an http app URL', () => {
    // Shopify refuses to embed it, and the admin shows a blank panel with no
    // error anywhere — indistinguishable from the app being broken.
    const problems = productionProblems(env({ APP_URL: 'http://codflow.app' }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/https/);
  });

  it('rejects the placeholder host', () => {
    expect(productionProblems(env({ APP_URL: 'https://codflow.example.com' }))).toHaveLength(1);
  });

  it('rejects localhost data stores, which in a container mean the container', () => {
    expect(
      productionProblems(env({ DATABASE_URL: 'postgresql://codflow@localhost:5432/codflow' })),
    ).toHaveLength(1);

    expect(productionProblems(env({ REDIS_URL: 'redis://127.0.0.1:6379' }))).toHaveLength(1);
  });

  it('reports every problem at once rather than one per boot attempt', () => {
    // A guard that failed on the first problem would take four deploys to get
    // through a misconfigured environment.
    const problems = productionProblems(
      env({
        APP_URL: 'http://codflow.example.com',
        ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        SESSION_SECRET: 'a'.repeat(64),
        DATABASE_URL: 'postgresql://codflow@localhost:5432/codflow',
      }),
    );

    // http, placeholder host, example key, placeholder secret, localhost db.
    expect(problems).toHaveLength(5);
  });
});

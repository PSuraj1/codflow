import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../app';

/**
 * HTTP test harness.
 *
 * Boots the real Express app on an ephemeral port and drives it with `fetch`.
 * No supertest: the app is already assembled by `createApp`, `fetch` is
 * built in, and going over a real socket exercises the middleware stack exactly
 * as production does — including the header handling that a supertest-style
 * in-process call can paper over.
 *
 * No database or Redis is needed. Every test here asserts on behaviour that
 * resolves *before* a data-layer call: authentication, validation, signature
 * verification, and the error envelope.
 */

export interface TestServer {
  readonly url: string;
  request(path: string, init?: RequestInit): Promise<TestResponse>;
  close(): Promise<void>;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  /** Error code from the envelope, or null on success. */
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export async function startTestServer(): Promise<TestServer> {
  const app = createApp();

  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,

    async request(path: string, init: RequestInit = {}): Promise<TestResponse> {
      const response = await fetch(`${url}${path}`, init);
      const text = await response.text();

      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // HTML responses — the exit-iframe page, the SPA shell.
      }

      const envelope = body as { error?: { code?: string; message?: string } } | undefined;

      return {
        status: response.status,
        headers: response.headers,
        body,
        errorCode: envelope?.error?.code ?? null,
        errorMessage: envelope?.error?.message ?? null,
      };
    },

    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Signs a query string the way Shopify signs app proxy requests: parameters
 * sorted, concatenated as `key=value` with no separator, HMAC-SHA256 hex.
 *
 * Must match `SHOPIFY_API_SECRET` in vitest.config.ts, or every signed request
 * in the suite silently becomes an unsigned one and the tests pass for the
 * wrong reason.
 */
export function signProxyQuery(params: Record<string, string>): string {
  const canonical = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}=${params[key]}`, '');

  return createHmac('sha256', 'test-api-secret').update(canonical).digest('hex');
}

/** A complete, correctly-signed app proxy query string. */
export function proxyQuery(overrides: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    shop: 'demo.myshopify.com',
    path_prefix: '/apps/codflow',
    timestamp: String(Math.floor(Date.now() / 1_000)),
    ...overrides,
  };

  return new URLSearchParams({ ...params, signature: signProxyQuery(params) }).toString();
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

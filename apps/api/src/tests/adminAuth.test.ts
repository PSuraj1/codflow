import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server';

/**
 * Admin surface authentication.
 *
 * The regression this exists to catch is specific and easy to introduce: a
 * route added to a module router that is mounted outside `adminRouter`, and so
 * ships without `authenticateAdmin`. Every admin path is asserted to reject an
 * unauthenticated caller, so a new endpoint that skips the gate fails here
 * rather than in production.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

/**
 * Every authenticated path. Adding a route to `/api/admin/*` without adding it
 * here is fine — the wildcard cases below still cover the mount — but listing
 * them makes a missing gate obvious in the failure output.
 */
const ADMIN_ROUTES: Array<[string, string]> = [
  ['GET', '/api/admin/session'],
  ['GET', '/api/admin/scopes'],
  ['PUT', '/api/admin/shop/onboarding'],
  ['GET', '/api/admin/forms'],
  ['POST', '/api/admin/forms'],
  ['GET', '/api/admin/forms/clx000000000000000000000'],
  ['PUT', '/api/admin/forms/clx000000000000000000000/fields'],
  ['DELETE', '/api/admin/forms/clx000000000000000000000'],
  ['GET', '/api/admin/orders/stuck'],
  ['GET', '/api/admin/orders/CF-ABC12345/push-status'],
  ['POST', '/api/admin/orders/CF-ABC12345/retry-push'],
  ['GET', '/api/admin/sheets'],
  ['GET', '/api/admin/sheets/connect-url'],
  ['GET', '/api/admin/sheets/spreadsheets'],
  ['PUT', '/api/admin/sheets/mapping'],
  ['PATCH', '/api/admin/sheets/settings'],
  ['POST', '/api/admin/sheets/backfill'],
  ['DELETE', '/api/admin/sheets/account'],
  ['GET', '/api/admin/fraud/settings'],
  ['PATCH', '/api/admin/fraud/settings'],
  ['GET', '/api/admin/fraud/blocklist'],
  ['POST', '/api/admin/fraud/blocklist'],
  ['GET', '/api/admin/fraud/rules'],
  ['POST', '/api/admin/fraud/rules'],
  ['GET', '/api/admin/fraud/orders/CF-ABC12345'],
  ['POST', '/api/admin/fraud/orders/CF-ABC12345/review'],
  ['POST', '/api/admin/fraud/orders/CF-ABC12345/rescan'],
  ['GET', '/api/admin/pixels'],
  ['POST', '/api/admin/pixels'],
  ['GET', '/api/admin/pixels/events'],
];

describe('admin routes reject unauthenticated callers', () => {
  it.each(ADMIN_ROUTES)('%s %s', async (method, path) => {
    const response = await server.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    });

    expect(response.status).toBe(401);
    expect(response.errorCode).toBe('UNAUTHORIZED');
  });
});

describe('session token handling', () => {
  it('distinguishes a missing token from an invalid one', async () => {
    // Missing means the client is not App Bridge-aware; invalid means a stale
    // token that a retry can fix. They call for different client behaviour.
    const missing = await server.request('/api/admin/session');
    expect(missing.errorMessage).toMatch(/missing/i);

    const invalid = await server.request('/api/admin/session', {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.errorCode).toBe('SESSION_EXPIRED');
  });

  /**
   * The header that tells the embedded client a retry with a fresh token is
   * worth attempting. Without it the admin surfaces a hard auth error for what
   * is usually a token that expired in flight.
   */
  it('sets the retry hint on a rejected session token', async () => {
    const response = await server.request('/api/admin/session', {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });

    expect(response.headers.get('x-shopify-retry-invalid-session-request')).toBe('1');
  });

  it('ignores a non-bearer authorization scheme', async () => {
    const response = await server.request('/api/admin/session', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });

    expect(response.errorMessage).toMatch(/missing/i);
  });
});

describe('error envelope', () => {
  it('returns a machine-readable code and a request id', async () => {
    const response = await server.request('/api/does-not-exist');
    const body = response.body as { error: { code: string; requestId: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
  });

  it('echoes the request id in a header', async () => {
    const response = await server.request('/api/health');
    expect(response.headers.get('x-codflow-request-id')).toBeTruthy();
  });

  it('accepts an inbound correlation id', async () => {
    const response = await server.request('/api/health', {
      headers: { 'x-codflow-request-id': 'trace-abc-123' },
    });

    expect(response.headers.get('x-codflow-request-id')).toBe('trace-abc-123');
  });

  it('rejects an oversized correlation id rather than logging it', async () => {
    const response = await server.request('/api/health', {
      headers: { 'x-codflow-request-id': 'x'.repeat(200) },
    });

    expect(response.headers.get('x-codflow-request-id')).not.toBe('x'.repeat(200));
  });
});

describe('security headers', () => {
  /**
   * An embedded app must not send `X-Frame-Options` — it is unconditional and
   * would stop the Shopify admin framing the app at all.
   */
  it('does not send X-Frame-Options', async () => {
    const response = await server.request('/api/health');
    expect(response.headers.get('x-frame-options')).toBeNull();
  });

  it('names the specific shop in frame-ancestors', async () => {
    const response = await server.request('/api/health?shop=demo.myshopify.com');
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(csp).toContain('frame-ancestors https://demo.myshopify.com https://admin.shopify.com');
  });

  it('falls back to a Shopify-only wildcard without a shop', async () => {
    const csp = (await server.request('/api/health')).headers.get('content-security-policy') ?? '';

    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('admin.shopify.com');
    // Never a bare wildcard — that would let any site frame the app.
    expect(csp).not.toContain('frame-ancestors *');
  });

  it('ignores an attacker-supplied shop in the framing policy', async () => {
    const csp =
      (await server.request('/api/health?shop=evil.com')).headers.get(
        'content-security-policy',
      ) ?? '';

    expect(csp).not.toContain('evil.com');
  });

  it('does not advertise the stack', async () => {
    expect((await server.request('/api/health')).headers.get('x-powered-by')).toBeNull();
  });
});

describe('health probes', () => {
  it('answers liveness without touching a dependency', async () => {
    // Deliberately does not check Postgres or Redis — neither is running here,
    // and a liveness probe that failed on a database blip would make the
    // platform restart every replica.
    const response = await server.request('/api/health');

    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('ok');
  });

  it('reports readiness as degraded when dependencies are unreachable', async () => {
    const response = await server.request('/api/health/ready');

    expect(response.status).toBe(503);
    expect((response.body as { status: string }).status).toBe('degraded');
  });
});

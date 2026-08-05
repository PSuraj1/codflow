import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jsonPost, proxyQuery, signProxyQuery, startTestServer, type TestServer } from './helpers/server';

/**
 * The public storefront surface.
 *
 * These are the app's most exposed endpoints — anonymous shoppers, arbitrary
 * merchant domains, no credentials — so the tests here are adversarial rather
 * than happy-path. Anything that resolves before a database call is asserted:
 * signature verification, freshness, input bounds, and the property that no
 * price can arrive from the browser.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

describe('app proxy verification', () => {
  it('rejects a request with no signature', async () => {
    const response = await server.request('/api/proxy/config?shop=demo.myshopify.com');

    expect(response.status).toBe(401);
    expect(response.errorMessage).toMatch(/signature/i);
  });

  it('rejects a forged signature', async () => {
    const query = new URLSearchParams({
      shop: 'demo.myshopify.com',
      path_prefix: '/apps/codflow',
      timestamp: String(Math.floor(Date.now() / 1_000)),
      signature: 'deadbeef',
    });

    const response = await server.request(`/api/proxy/config?${query.toString()}`);

    expect(response.status).toBe(401);
    expect(response.errorMessage).toMatch(/signature/i);
  });

  /**
   * A stale request and an unsigned one must report differently. Conflating
   * them sends an operator hunting for a leaked app secret when the real cause
   * is clock skew — or the reverse.
   */
  it('reports an expired request distinctly from a bad signature', async () => {
    const response = await server.request(
      `/api/proxy/config?${proxyQuery({ timestamp: String(Math.floor(Date.now() / 1_000) - 600) })}`,
    );

    expect(response.status).toBe(401);
    expect(response.errorMessage).toMatch(/expired/i);
  });

  it('rejects a request whose timestamp was removed', async () => {
    // Signed correctly but with no timestamp: never came through the proxy.
    const params = { shop: 'demo.myshopify.com', path_prefix: '/apps/codflow' };
    const query = new URLSearchParams({ ...params, signature: signProxyQuery(params) });

    const response = await server.request(`/api/proxy/config?${query.toString()}`);

    expect(response.status).toBe(401);
    expect(response.errorMessage).toMatch(/signature/i);
  });

  /**
   * The signature is valid, so this genuinely came from Shopify — but a shop
   * value that fails sanitization would poison every lookup keyed on it.
   */
  it('rejects a valid signature carrying a non-Shopify domain', async () => {
    const response = await server.request(`/api/proxy/config?${proxyQuery({ shop: 'evil.com' })}`);

    expect(response.status).toBe(401);
  });

  it('lets a correctly signed request through to the service layer', async () => {
    // No database here, so a 5xx means it passed every gate and reached the
    // data layer — which is exactly what this asserts.
    const response = await server.request(`/api/proxy/config?${proxyQuery()}`);

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('order submission', () => {
  const validBody = {
    formToken: 'v1.body.signature',
    formId: 'clx000000000000000000000',
    lineItems: [{ variantId: '123456', quantity: 1 }],
    values: { phone: '+919876543210' },
  };

  it('rejects an empty body', async () => {
    const response = await server.request(`/api/proxy/order?${proxyQuery()}`, jsonPost({}));

    expect(response.status).toBe(422);
    expect(response.errorCode).toBe('VALIDATION_FAILED');
  });

  /**
   * The single most important property of this endpoint. A `price` field has no
   * place in the schema, so Zod strips it and the request proceeds as though it
   * were never sent — every amount is resolved from Shopify server-side.
   */
  it('silently discards a client-supplied price', async () => {
    const withPrice = {
      ...validBody,
      lineItems: [{ variantId: '123456', quantity: 1, price: '0.01' }],
    };

    const response = await server.request(`/api/proxy/order?${proxyQuery()}`, jsonPost(withPrice));

    // Reaches form-token verification, which means validation accepted the body
    // with the extra key removed rather than rejecting or honouring it.
    expect(response.status).toBe(400);
    expect(response.errorMessage).toMatch(/could not be verified/i);
  });

  it.each([
    ['a path-traversal variant id', { variantId: '../../etc/passwd', quantity: 1 }],
    ['a negative quantity', { variantId: '123', quantity: -1 }],
    ['a zero quantity', { variantId: '123', quantity: 0 }],
    ['an absurd quantity', { variantId: '123', quantity: 9_999 }],
    ['a fractional quantity', { variantId: '123', quantity: 1.5 }],
  ])('rejects %s', async (_label, lineItem) => {
    const response = await server.request(
      `/api/proxy/order?${proxyQuery()}`,
      jsonPost({ ...validBody, lineItems: [lineItem] }),
    );

    expect(response.status).toBe(422);
  });

  it('rejects a forged form token', async () => {
    const response = await server.request(
      `/api/proxy/order?${proxyQuery()}`,
      jsonPost({ ...validBody, formToken: 'v1.forged.signature' }),
    );

    expect(response.status).toBe(400);
    expect(response.errorMessage).toMatch(/could not be verified/i);
  });

  it('rejects an order with no line items', async () => {
    const response = await server.request(
      `/api/proxy/order?${proxyQuery()}`,
      jsonPost({ ...validBody, lineItems: [] }),
    );

    expect(response.status).toBe(422);
  });

  it('bounds the number of line items', async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      variantId: String(index),
      quantity: 1,
    }));

    const response = await server.request(
      `/api/proxy/order?${proxyQuery()}`,
      jsonPost({ ...validBody, lineItems: many }),
    );

    expect(response.status).toBe(422);
  });

  it('requires a signed proxy request', async () => {
    const response = await server.request('/api/proxy/order', jsonPost(validBody));
    expect(response.status).toBe(401);
  });
});

describe('direct storefront endpoint', () => {
  it('validates the product id shape', async () => {
    const response = await server.request(
      '/api/storefront/config?shop=demo.myshopify.com&productId=../etc',
    );

    expect(response.status).toBe(422);
    expect(response.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects a non-Shopify shop', async () => {
    const response = await server.request('/api/storefront/config?shop=evil.com');
    expect(response.status).toBe(400);
  });

  it('accepts a numeric product id', async () => {
    const response = await server.request(
      '/api/storefront/config?shop=demo.myshopify.com&productId=123456',
    );

    // Past validation, into the data layer.
    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it('accepts a product GID', async () => {
    const response = await server.request(
      `/api/storefront/config?shop=demo.myshopify.com&productId=${encodeURIComponent('gid://shopify/Product/123')}`,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('webhooks', () => {
  it('rejects an unsigned delivery', async () => {
    const response = await server.request('/api/webhooks/orders/create', jsonPost({}));

    expect(response.status).toBe(401);
    expect(response.errorCode).toBe('WEBHOOK_INVALID');
  });

  it('rejects an empty body', async () => {
    const response = await server.request('/api/webhooks/orders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(401);
  });
});

describe('public auth routes', () => {
  it('rejects an install request for a non-Shopify domain', async () => {
    // This route builds a redirect from the shop parameter, so an unvalidated
    // value would make it an open redirect on a domain merchants trust.
    const response = await server.request('/api/auth/install?shop=evil.com', { redirect: 'manual' });

    expect(response.status).toBe(400);
  });

  it('redirects a valid install request to Shopify', async () => {
    const response = await server.request('/api/auth/install?shop=demo.myshopify.com', {
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('demo.myshopify.com/admin/oauth/install');
  });

  it('serves the exit-iframe page with a nonce-scoped policy', async () => {
    const response = await server.request('/api/auth/exit-iframe?shop=demo.myshopify.com');
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(response.status).toBe(200);

    // The app-wide policy sets `script-src 'self'`, so the inline escape script
    // needs a nonce or the browser silently refuses to run it and the merchant
    // sees a blank page.
    expect(csp).toContain("script-src 'nonce-");

    // The claim that matters is narrower than "no unsafe-inline anywhere":
    // `style-src 'unsafe-inline'` is present and harmless on a page with no
    // user content. What must never appear is an inline *script* allowance,
    // which would let any injected script run alongside the nonced one.
    const scriptSrc = csp.split(';').find((directive) => directive.includes('script-src')) ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('rejects a legacy callback with no HMAC', async () => {
    const response = await server.request('/api/auth/callback?shop=demo.myshopify.com', {
      redirect: 'manual',
    });

    expect(response.status).toBe(401);
  });
});

describe('google oauth callback', () => {
  it.each([
    ['no state', '/api/google/callback'],
    ['a forged state', '/api/google/callback?state=v1.abc.forged&code=x'],
    ['a malformed state', '/api/google/callback?state=garbage'],
  ])('rejects %s', async (_label, path) => {
    const response = await server.request(path, { redirect: 'manual' });

    expect(response.status).toBe(400);
    // Identical message for every failure — it leaks nothing about which check
    // failed.
    expect(response.errorMessage).toMatch(/not valid/i);
  });
});

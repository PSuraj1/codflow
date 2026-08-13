import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers/server';

/**
 * The public landing page.
 *
 * Written against a real rejection. Google's OAuth branding verification looked
 * at `/` and reported three faults — behind a login, no explanation of the
 * app's purpose, name not matching the consent screen — all caused by one
 * thing: `/` returned the admin's `index.html`, which is empty until React
 * fills it in, and the verifier does not run JavaScript.
 *
 * So the assertions below are the verifier's checklist, plus the one thing that
 * must not regress in exchange: a merchant arriving from Shopify has to keep
 * reaching the app.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.close();
});

async function landingHtml(path = '/'): Promise<string> {
  const response = await server.request(path);

  expect(response.status).toBe(200);

  // The helper parses JSON where it can and leaves HTML as a string.
  return response.body as string;
}

describe('what a verifier sees', () => {
  it('serves HTML without needing JavaScript', async () => {
    const html = await landingHtml();

    // The failure that caused all of this: content only React could produce.
    expect(html).not.toContain('<div id="root"></div>');
    expect(html).toContain('<h1>CODkar</h1>');
  });

  it('carries the same app name as the OAuth consent screen', async () => {
    // "The app name 'CODkar' configured for your OAuth consent screen does not
    // match the app name on your home page."
    expect(await landingHtml()).toContain('CODkar');
  });

  it('explains what the app is for in prose, not in a script tag', async () => {
    const html = await landingHtml();

    expect(html).toMatch(/cash-on-delivery app for Shopify/i);
    expect(html).toMatch(/replaces checkout/i);
  });

  it('says why it asks for Google account access', async () => {
    // The verifier is reviewing a Google OAuth grant, so the reason for the
    // scopes belongs on the page it is looking at.
    expect(await landingHtml()).toMatch(/Google Sheets/i);
  });

  it('links the privacy policy and terms, which the verifier follows next', async () => {
    const html = await landingHtml();

    expect(html).toContain('/legal/privacy');
    expect(html).toContain('/legal/terms');
  });

  it('is not behind a login and asks for nothing', async () => {
    const html = await landingHtml();

    expect(html.toLowerCase()).not.toMatch(/<input|<form|sign in|log in/);
  });
});

describe('merchants still reach the app', () => {
  it('does not intercept an embedded load from Shopify', async () => {
    // Shopify's entry: ?shop=&host=&embedded=1. Serving the landing page here
    // would replace the admin with a marketing page for every merchant.
    const response = await server.request(
      '/?shop=demo.myshopify.com&host=YWRtaW4uc2hvcGlmeS5jb20&embedded=1',
    );

    expect(String(response.body)).not.toContain('<h1>CODkar</h1>');
  });

  it('does not intercept a request carrying only host', async () => {
    const response = await server.request('/?host=YWRtaW4uc2hvcGlmeS5jb20');

    expect(String(response.body)).not.toContain('<h1>CODkar</h1>');
  });

  it('still redirects a bare shop parameter into the admin', async () => {
    // `?shop=` without `embedded=1` is a bookmark or an email link, and the
    // redirect into the admin deep link is what rescues it.
    // `redirect: 'manual'` because fetch follows redirects by default, which
    // would report the destination's status instead of the redirect itself.
    const response = await server.request('/?shop=demo.myshopify.com', {
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
  });
});

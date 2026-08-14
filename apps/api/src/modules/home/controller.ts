import type { NextFunction, Request, Response } from 'express';
import { HELP_PAGES, LEGAL_PAGES, helpPath, legalPath } from '@codflow/shared';
import { renderPage } from '../legal/markdown';

/**
 * The public landing page at `/`.
 *
 * Exists because of a specific rejection. Google's OAuth branding verification
 * fetched `https://app.codflow.in/` and reported that the page was behind a
 * login, did not explain the app's purpose, and did not carry the app's name —
 * three complaints with one cause: `/` served the admin's `index.html`, whose
 * entire content is rendered by React into an empty `<div id="root">`. A
 * crawler that does not execute JavaScript sees a blank document.
 *
 * So this is rendered on the server, as HTML, with no script of any kind. Every
 * verifier requirement is met by the markup itself:
 *
 *  - the name matches the OAuth consent screen exactly — "CODkar";
 *  - the purpose is in the first sentence;
 *  - nothing is behind authentication;
 *  - the privacy policy and terms are linked, which is what the verifier
 *    follows next.
 *
 * It must never intercept a merchant. Shopify always arrives with `shop`,
 * `host` or `embedded` on the query string, so a request carrying any of them
 * is handed straight back to the admin entry point.
 */

function links(): string {
  const help = HELP_PAGES.map(
    (page) => `<li><a href="${helpPath(page.slug)}">${page.title}</a></li>`,
  ).join('');

  const legal = LEGAL_PAGES.map(
    (page) => `<li><a href="${legalPath(page.slug)}">${page.title}</a></li>`,
  ).join('');

  return `<ul>${help}${legal}</ul>`;
}

const BODY = `
  <h1>CODkar</h1>

  <p><strong>CODkar is a cash-on-delivery app for Shopify stores.</strong> It
  replaces checkout with a single order form on the product page, so a shopper
  can place a cash-on-delivery order without an account and without entering
  payment details. The order arrives in the merchant's Shopify admin as a normal
  order, marked payment pending.</p>

  <h2>What it does</h2>

  <ul>
    <li>Adds a cash-on-delivery button and order form to any product page.</li>
    <li>Checks each order against block lists, postal-code rules and bot
        signals before it reaches the merchant, and holds anything suspicious
        for review.</li>
    <li>Exports orders to the merchant's own Google Sheet for fulfilment.</li>
    <li>Reports conversions to ad platforms, which otherwise never see a COD
        order because it does not pass through Shopify checkout.</li>
  </ul>

  <h2>Google account access</h2>

  <p>CODkar asks for access to Google Sheets only to write the merchant's own
  cash-on-delivery orders into a spreadsheet they choose or create from inside
  the app. It is used for nothing else, and the merchant can disconnect the
  account at any time from the app's settings.</p>

  <h2>Installing</h2>

  <p>CODkar is a Shopify app and runs inside the Shopify admin. Install it from
  the Shopify App Store, then open it from <strong>Apps</strong> in your admin.
  This page is not the application itself.</p>

  <h2>More</h2>

  ${links()}

  <p>CODkar is published by Identiwitty Media Pvt Ltd, New Delhi, India.</p>
`;

const HTML = renderPage('Cash on delivery for Shopify', BODY);

/**
 * `GET /` for everyone who is not Shopify.
 *
 * Falls through to the admin entry whenever the request looks like it came from
 * the Shopify admin, which is the only case that must keep working.
 */
export function landing(req: Request, res: Response, next: NextFunction): void {
  if (req.query.shop || req.query.host || req.query.embedded) {
    next();
    return;
  }

  res.type('html');
  // Short enough that a correction reaches a verifier who is retrying today.
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(HTML);
}

/**
 * `GET /robots.txt`.
 *
 * Without this the SPA catch-all answers it with the admin's `index.html` — a
 * crawler asking for a robots file receives an HTML document. Most parsers treat
 * that as "no rules" and carry on, but it is an odd signal to send a verifier
 * that is deciding whether it can read the site, and this app has one waiting
 * on exactly that question.
 *
 * What it permits is deliberate: the pages meant to be read by people and
 * indexed — the landing page, the policies, the FAQ — and nothing else. The
 * admin routes below `/api` and the client-side screens are useless to a
 * crawler and would be dead entries in an index.
 */
const ROBOTS = `User-agent: *
Allow: /$
Allow: /legal/
Allow: /help/
Disallow: /api/
Disallow: /assets/
`;

export function robots(_req: Request, res: Response): void {
  res.type('text/plain');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(ROBOTS);
}

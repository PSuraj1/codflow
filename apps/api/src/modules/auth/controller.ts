import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { InvalidHmacError } from '@shopify/shopify-api';
import { shopify } from '../../shopify/client';
import { embeddedAppUrl, managedInstallUrl } from '../../shopify/urls';
import { createLogger } from '../../lib/logger';
import { requireShopDomain } from '../../lib/shopDomain';
import { BadRequestError, UnauthorizedError, toError } from '../../lib/errors';
import { ok } from '../../lib/http';
import * as service from './service';

const log = createLogger('auth-controller');

/**
 * Authentication HTTP surface.
 *
 * Under managed installation this is much smaller than a legacy OAuth app's:
 * there is no `/auth/begin`, no `state` nonce cookie, and no code-for-token
 * exchange endpoint, because Shopify performs the grant. What remains are the
 * routes that move a merchant *between frames* — which is a real problem in an
 * embedded app, because the consent screen refuses to render inside an iframe.
 */

/**
 * `GET /api/auth/reauthorize` — send the merchant back through consent.
 *
 * Referenced by the `X-Shopify-API-Request-Failure-Reauthorize-Url` header on
 * every 403 the app raises for revoked tokens or widened scopes. The client is
 * expected to open it in the top frame, so by the time the browser arrives here
 * the navigation is already top-level and a plain redirect is enough.
 *
 * A `Sec-Fetch-Dest: iframe` request means the client redirected its own frame
 * instead. Redirecting again would land on Shopify's `frame-ancestors 'none'`
 * and show a blank panel, so those are handed to the exit-iframe page.
 */
export function reauthorize(req: Request, res: Response, next: NextFunction): void {
  try {
    const shop = requireShopDomain(req.query.shop as string | undefined);
    const target = managedInstallUrl(shop);

    if (req.get('sec-fetch-dest') === 'iframe') {
      log.debug({ shop }, 'Reauthorize requested from inside an iframe — escaping first');
      renderExitIframe(res, target, shop);
      return;
    }

    log.info({ shop }, 'Redirecting merchant to managed installation');
    res.redirect(302, target);
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /api/auth/exit-iframe` — break out of the app iframe.
 *
 * Only two destinations are permitted, both derived from the sanitized shop
 * domain: Shopify's install screen and the app's own deep link. Accepting a
 * `redirect` parameter here instead would make this an open redirect on a
 * domain merchants trust, which is worth more to a phisher than anything else
 * in the app.
 */
export function exitIframe(req: Request, res: Response, next: NextFunction): void {
  try {
    const shop = requireShopDomain(req.query.shop as string | undefined);
    const destination = req.query.target === 'app' ? embeddedAppUrl(shop) : managedInstallUrl(shop);

    renderExitIframe(res, destination, shop);
  } catch (error) {
    next(error);
  }
}

/**
 * Serves a page whose only job is to navigate the top window.
 *
 * The inline script carries a per-response nonce because the app's CSP sets
 * `script-src 'self'` — without the nonce the browser silently refuses to run
 * it and the merchant sees an empty page with no error. The `<noscript>`
 * fallback matters too: some admin embedded contexts and privacy extensions
 * block inline execution regardless, and a visible link is better than a dead
 * end.
 */
function renderExitIframe(res: Response, destination: string, shop: string): void {
  const nonce = randomBytes(16).toString('base64');

  // Overrides the app-wide policy for this response only, widening it just far
  // enough to run one nonce'd script and nothing else.
  res.setHeader(
    'Content-Security-Policy',
    [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'unsafe-inline'`,
      `frame-ancestors https://${shop} https://admin.shopify.com`,
    ].join('; '),
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  // `destination` is always built from a sanitized shop domain plus a constant,
  // so it cannot contain merchant-supplied text. JSON encoding it keeps that
  // true even if a future caller passes something less trustworthy.
  const encoded = JSON.stringify(destination);

  res.status(200).send(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Redirecting…</title>
  </head>
  <body>
    <p>Redirecting to Shopify… <a href="${destination}" target="_top">Continue</a></p>
    <script nonce="${nonce}">
      // window.top is the Shopify admin. Assigning to its location is what
      // escapes the app iframe; assigning to window.location would navigate
      // this frame and hit Shopify's frame-ancestors block instead.
      window.top.location.href = ${encoded};
    </script>
    <noscript>
      <p>JavaScript is required. <a href="${destination}" target="_top">Continue to Shopify</a>.</p>
    </noscript>
  </body>
</html>`,
  );
}

/**
 * `GET /api/auth/install` — entry point for a merchant who arrived without a
 * session, typically from a bookmark or a link outside the admin.
 *
 * Sends them into managed installation, which either installs the app or, if it
 * is already installed, bounces straight back to it.
 */
export function install(req: Request, res: Response, next: NextFunction): void {
  try {
    const shop = requireShopDomain(req.query.shop as string | undefined);
    res.redirect(302, managedInstallUrl(shop));
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /api/auth/callback` — the legacy OAuth return path.
 *
 * Managed installation never uses this: Shopify completes the grant itself and
 * redirects to `application_url`, not here. The route exists because
 * shopify.app.toml must declare `redirect_urls`, and because a store that
 * installed under an older build of the app can still be redirected here by a
 * cached URL.
 *
 * It does not exchange a code for a token — that path is gone. It verifies the
 * HMAC so the route cannot be used as an unauthenticated redirector, then sends
 * the merchant into the embedded app, where token exchange takes over.
 */
export async function callback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const shop = requireShopDomain(req.query.shop as string | undefined);

    let valid = false;
    try {
      valid = await shopify.utils.validateHmac(req.query as Record<string, string>, {
        signator: 'admin',
      });
    } catch (error) {
      if (!(error instanceof InvalidHmacError)) throw error;
      log.warn({ shop, err: toError(error) }, 'Legacy callback hit without an HMAC');
    }

    if (!valid) {
      throw new UnauthorizedError('Callback signature verification failed');
    }

    log.info({ shop }, 'Legacy OAuth callback — forwarding into the embedded app');
    res.redirect(302, embeddedAppUrl(shop));
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /api/auth/scopes` — what the app needs versus what it has.
 *
 * Authenticated, and used by the admin's permissions banner. Reads the session
 * the auth middleware already resolved, so it costs no extra Shopify call.
 */
export function scopes(req: Request, res: Response, next: NextFunction): void {
  try {
    if (!req.auth) throw new BadRequestError('Not authenticated');
    ok(res, service.evaluateScopes(req.auth.session.scope));
  } catch (error) {
    next(error);
  }
}

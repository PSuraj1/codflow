import { config } from '../config/env';
import { shopHandle } from '../lib/shopDomain';

/**
 * Shopify URL builders.
 *
 * These are collected in one file because the correct form of each is
 * non-obvious and getting one wrong fails quietly — a bad embedded URL renders
 * a blank iframe, a bad install URL loops the merchant through consent forever.
 */

/**
 * Managed installation / re-consent entry point.
 *
 * Under managed installation the app never builds an authorization-code URL
 * itself; it sends the merchant here and Shopify runs the grant, then redirects
 * to `application_url`. This is also the URL to use when granted scopes no
 * longer cover what shopify.app.toml declares — visiting it re-prompts for the
 * full current scope set.
 *
 * Must be opened in the top frame. Shopify sends `frame-ancestors 'none'` on
 * the consent screen, so loading it inside the app iframe shows nothing.
 */
export function managedInstallUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/oauth/install?client_id=${encodeURIComponent(
    config.shopify.apiKey,
  )}`;
}

/**
 * Deep link to the app inside the Shopify admin.
 *
 * Used after a non-embedded entry (a bookmark, an email link) to put the
 * merchant back inside the admin chrome, which is where an embedded app is
 * required to run.
 */
export function embeddedAppUrl(shopDomain: string, path = '/'): string {
  const handle = shopHandle(shopDomain);
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `https://admin.shopify.com/store/${handle}/apps/${config.shopify.apiKey}${suffix}`;
}

/** Absolute URL on this app's own origin. */
export function appUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${config.server.appUrl}${suffix}`;
}

/**
 * Where a 403 REAUTH/SCOPES_CHANGED response points the client.
 *
 * Goes through the app's own exit-iframe route rather than straight to
 * `managedInstallUrl` so that clients which cannot escape the iframe themselves
 * still end up in the top window.
 */
export function reauthorizeUrl(shopDomain: string): string {
  return appUrl(`/api/auth/reauthorize?shop=${encodeURIComponent(shopDomain)}`);
}

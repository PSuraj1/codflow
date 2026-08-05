import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InvalidHmacError } from '@shopify/shopify-api';
import { shopify } from '../shopify/client';
import { createLogger } from '../lib/logger';
import { normalizeShopDomain } from '../lib/shopDomain';
import { UnauthorizedError, toError } from '../lib/errors';

const log = createLogger('verify-app-proxy');

/**
 * Verifies a Shopify app proxy request.
 *
 * When a shopper's browser hits `https://<shop>/apps/codflow/config`, Shopify
 * forwards it to this app and appends a signed set of parameters:
 *
 *   shop, path_prefix, timestamp, logged_in_customer_id, signature
 *
 * The `signature` is an HMAC over the remaining query parameters using the app
 * secret. Checking it proves the request genuinely passed through a storefront
 * — which is a real authenticity signal, and one the equivalent direct CORS
 * endpoint cannot offer.
 *
 * What it deliberately does *not* prove, and which the rest of the app must not
 * assume: **it does not authenticate the shopper.** Anyone who can load the
 * store can trigger a signed proxy request. `logged_in_customer_id` is the only
 * identity signal and it is absent for guests, which is most COD traffic.
 */

/**
 * How old a proxy request may be.
 *
 * `shopify.utils.validateHmac` already enforces a 90-second window internally
 * and rejects anything older. The check is repeated here for two reasons: that
 * behaviour is an undocumented implementation detail rather than part of the
 * library's contract, and checking first lets an expired request be reported as
 * expired instead of as a bad signature — which is the difference between a
 * clock-skew diagnosis and a wild goose chase after the app secret.
 */
const MAX_TIMESTAMP_SKEW_SECONDS = 90;

function timestampIsFresh(value: string | undefined): boolean {
  if (!value) return false;

  const timestamp = Number.parseInt(value, 10);
  if (!Number.isFinite(timestamp)) return false;

  const ageSeconds = Math.abs(Date.now() / 1_000 - timestamp);
  return ageSeconds <= MAX_TIMESTAMP_SKEW_SECONDS;
}

export const verifyAppProxy: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const query = req.query as Record<string, string>;

    // A request with no signature or timestamp never came through the proxy at
    // all — someone is calling the path directly. Reporting that as "expired"
    // would send an operator hunting for clock skew that does not exist.
    if (!query.signature || !query.timestamp) {
      throw new UnauthorizedError('App proxy signature verification failed');
    }

    // Freshness before the signature, so a genuinely stale request reports as
    // stale rather than as a bad signature.
    if (!timestampIsFresh(query.timestamp)) {
      log.warn({ shop: query.shop, timestamp: query.timestamp }, 'Stale app proxy request');
      throw new UnauthorizedError('App proxy request has expired');
    }

    let valid = false;
    try {
      valid = await shopify.utils.validateHmac(query, { signator: 'appProxy' });
    } catch (error) {
      // Thrown when `signature` is absent entirely — someone calling the proxy
      // path directly rather than through a storefront.
      if (!(error instanceof InvalidHmacError)) throw error;
      log.debug({ err: toError(error) }, 'App proxy request carried no signature');
    }

    if (!valid) {
      throw new UnauthorizedError('App proxy signature verification failed');
    }

    const shopDomain = normalizeShopDomain(query.shop);

    if (!shopDomain) {
      // The signature is valid, so this came from Shopify — but a shop value
      // that fails sanitization would poison every lookup keyed on it.
      throw new UnauthorizedError('App proxy request carried an invalid shop domain');
    }

    // Republished under the app's own header so the shared storefront
    // controller reads the shop identically whether it was reached through the
    // proxy or through the direct CORS route.
    req.headers['x-codflow-shop'] = shopDomain;

    next();
  } catch (error) {
    next(error);
  }
};

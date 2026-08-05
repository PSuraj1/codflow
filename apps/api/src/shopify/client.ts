// The runtime adapter must be imported for its side effects BEFORE shopifyApi
// is called — it installs the platform's crypto/fetch/Request implementations
// into the library's abstraction layer. Without it every call fails at runtime
// with "Missing adapter implementation", which is not obvious from the message.
import '@shopify/shopify-api/adapters/node';

import {
  ApiVersion,
  LogSeverity,
  shopifyApi,
  type ConfigParams,
  type Shopify,
} from '@shopify/shopify-api';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';
import { InternalError } from '../lib/errors';

const log = createLogger('shopify');

/**
 * Resolves the configured API version string to the library's enum.
 *
 * `@shopify/shopify-api` v13 removed the `LATEST_API_VERSION` export, so the
 * version has to be named explicitly. Shopify does not offer a `latest` alias
 * on the endpoint either — requesting a retired version silently falls forward
 * to the oldest supported one, which produces confusing GraphQL field errors
 * rather than a clear failure. Validating here turns a typo in `.env` into a
 * boot-time error listing the valid values.
 */
function resolveApiVersion(version: string): ApiVersion {
  const known = Object.values(ApiVersion) as string[];

  if (!known.includes(version)) {
    throw new InternalError(
      `SHOPIFY_API_VERSION "${version}" is not supported by @shopify/shopify-api. ` +
        `Valid values: ${known.join(', ')}`,
    );
  }

  return version as ApiVersion;
}

const params = {
  apiKey: config.shopify.apiKey,
  apiSecretKey: config.shopify.apiSecret,
  scopes: config.shopify.scopes,
  // Host WITHOUT protocol. Passing a full URL here produces malformed OAuth
  // and host-verification URLs.
  hostName: config.server.hostName,
  hostScheme: 'https',
  apiVersion: resolveApiVersion(config.shopify.apiVersion),
  isEmbeddedApp: true,
  // Managed installation: Shopify performs the OAuth grant itself and the app
  // obtains tokens by exchanging the App Bridge session token. This must stay
  // false and must match `use_legacy_install_flow = false` in shopify.app.toml.
  isCustomStoreApp: false,
  logger: {
    level: config.isProduction ? LogSeverity.Warning : LogSeverity.Info,
    httpRequests: config.isDevelopment,
    timestamps: false,
    // Route the library's own logging through pino so it is redacted and
    // structured like everything else.
    log: async (severity: LogSeverity, message: string): Promise<void> => {
      switch (severity) {
        case LogSeverity.Error:
          log.error(message);
          break;
        case LogSeverity.Warning:
          log.warn(message);
          break;
        case LogSeverity.Debug:
          log.debug(message);
          break;
        default:
          log.info(message);
      }
    },
  },
} satisfies ConfigParams;

export const shopify: Shopify<typeof params> = shopifyApi(params);

/** The API version actually in use, for logging and GraphQL endpoint building. */
export const API_VERSION: string = params.apiVersion;

/**
 * Normalizes and validates a shop domain.
 *
 * Every public entry point that accepts a `shop` parameter must pass it through
 * this before it reaches a query or a redirect. `sanitizeShop` rejects anything
 * that is not a genuine `*.myshopify.com` host, which is what stops an attacker
 * from pointing the app at a domain they control.
 */
export function sanitizeShopDomain(shop: string | undefined | null): string | null {
  if (!shop) return null;
  return shopify.utils.sanitizeShop(shop, false);
}

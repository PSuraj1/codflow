import cors, { type CorsOptions } from 'cors';
import { config } from '../config/env';
import { normalizeShopDomain } from '../lib/shopDomain';

/**
 * Cross-origin policy.
 *
 * Two audiences with opposite requirements share this server:
 *
 *  - The **admin SPA** runs on the app's own origin in production, but on the
 *    Vite dev server during development. Only that one extra origin is allowed,
 *    and only with credentials.
 *  - **Storefront** requests come from arbitrary merchant domains — a shop can
 *    serve the COD form from `shop.myshopify.com` or from any custom domain it
 *    has mapped. Those endpoints are public and bearer-token-free, so they are
 *    opened to any origin *without* credentials. Reflecting an arbitrary origin
 *    while also allowing credentials would be the classic CORS hole; keeping
 *    `credentials: false` is what makes the open policy safe.
 */

/** Origins permitted to call `/api/admin/*`. */
function adminOrigins(): string[] {
  const origins = new Set<string>([config.server.appUrl]);

  if (config.server.adminOrigin) {
    origins.add(config.server.adminOrigin.replace(/\/$/, ''));
  }

  if (!config.isProduction) {
    // Vite's dev server, on both loopback spellings.
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
  }

  return [...origins];
}

const adminOptions: CorsOptions = {
  origin(origin, callback) {
    // Same-origin requests and server-to-server calls send no Origin header.
    if (!origin) return callback(null, true);

    if (adminOrigins().includes(origin.replace(/\/$/, ''))) {
      return callback(null, true);
    }

    // A myshopify origin reaching an admin route means the embedded app is
    // being framed and calling out directly, which is legitimate.
    if (normalizeShopDomain(origin)) return callback(null, true);

    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CodFlow-Request-Id'],
  exposedHeaders: [
    'X-CodFlow-Request-Id',
    'X-Shopify-API-Request-Failure-Reauthorize',
    'X-Shopify-API-Request-Failure-Reauthorize-Url',
    'X-Shopify-Retry-Invalid-Session-Request',
    'Retry-After',
  ],
  maxAge: 86_400,
};

const storefrontOptions: CorsOptions = {
  origin: true,
  // Never true. See the note above — an open origin plus credentials would let
  // any site read a merchant's COD data using a visitor's cookies.
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-CodFlow-Shop', 'X-CodFlow-Form-Token'],
  exposedHeaders: ['X-CodFlow-Request-Id', 'Retry-After'],
  maxAge: 3_600,
};

export const adminCors = cors(adminOptions);
export const storefrontCors = cors(storefrontOptions);

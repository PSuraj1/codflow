import path from 'node:path';
import fs from 'node:fs';
import express, { type Express, type Request, type Response } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config/env';
import { createLogger } from './lib/logger';
import { normalizeShopDomain } from './lib/shopDomain';
import { embeddedAppUrl } from './shopify/urls';
import { requestId } from './middlewares/requestId';
import { httpLogger } from './middlewares/httpLogger';
import { securityHeaders } from './middlewares/security';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { webhookRouter } from './modules/webhooks/routes';
import { apiRouter } from './routes';
import { helpRouter, legalRouter } from './modules/legal/routes';
import { landing, robots } from './modules/home/controller';

const log = createLogger('app');

/**
 * Express application assembly.
 *
 * The order of the stack below is the load-bearing part of this file. Three
 * positions in particular are not interchangeable:
 *
 *  1. **`requestId` first.** Everything downstream — the access log, the error
 *     handler, audit rows — reads the correlation id it sets.
 *  2. **Webhooks before `express.json`.** Shopify's HMAC covers the exact bytes
 *     it sent. Once the JSON parser has consumed the stream those bytes are
 *     gone, and every webhook fails verification for reasons that look like a
 *     wrong API secret.
 *  3. **`errorHandler` last.** Express identifies error middleware by arity and
 *     only reaches it after every other layer has declined, so registering it
 *     earlier silently disables it.
 */
export function createApp(): Express {
  const app = express();

  // Railway, Render and Fly all terminate TLS at a single proxy hop. Without
  // this `req.ip` is the proxy's address, which would key every rate limiter to
  // one bucket and record the wrong IP on every COD order the fraud engine
  // scores. `1` rather than `true`: trusting the whole chain lets a client
  // forge X-Forwarded-For and impersonate any address it likes.
  app.set('trust proxy', 1);

  // Nothing here renders server-side templates, and the header advertises the
  // stack to anyone scanning.
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(requestId);
  app.use(httpLogger);
  app.use(...securityHeaders);
  app.use(compression());
  app.use(cookieParser(config.security.sessionSecret));

  // ---- Webhooks. Mounted before any body parser; see note (2) above.
  app.use('/api/webhooks', webhookRouter);

  // ---- Body parsing for everything else.
  //
  // 1mb is generous for this app's largest legitimate payload (a form config
  // with many fields and translations) and small enough that an oversized body
  // is rejected before it is buffered into memory.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use('/api', apiRouter);

  // ---- Public legal pages. Mounted before the SPA so the admin's catch-all
  // does not swallow them, and outside `/api` because these URLs go on the
  // App Store listing and are read by people, not by the app.
  app.use('/legal', legalRouter);
  app.use('/help', helpRouter);

  // ---- The public landing page. Before `mountAdmin` because it claims `/`
  // for requests that are not Shopify, and hands every other one straight back.
  app.get('/', landing);
  app.get('/robots.txt', robots);

  // ---- The embedded admin SPA.
  mountAdmin(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Serves the built admin, or explains itself when there is nothing to serve.
 *
 * In production the Docker image copies `apps/admin/dist` next to the API and
 * this becomes the app's front door. In development the Shopify CLI points the
 * tunnel at Vite instead, so the directory is absent — and a merchant (or a
 * developer) who reaches the API origin directly gets a page that tells them
 * where to go rather than a bare 404.
 */
function mountAdmin(app: Express): void {
  const adminDist = path.resolve(__dirname, '../../admin/dist');
  const indexFile = path.join(adminDist, 'index.html');
  const hasBuild = fs.existsSync(indexFile);

  if (!hasBuild) {
    log.warn({ adminDist }, 'No admin build found — serving the entry page only');
  }

  /**
   * The app's entry point.
   *
   * Shopify sends merchants here with `?shop=&host=&embedded=1`. A request
   * without `embedded=1` came from outside the admin — a bookmark, an email
   * link — and an embedded app must not try to render there. Redirecting into
   * the admin deep link is what turns that dead end into a working entry.
   */
  const serveEntry = (req: Request, res: Response, next: express.NextFunction): void => {
    const shop = normalizeShopDomain(req.query.shop as string | undefined);
    const isEmbedded = req.query.embedded === '1' || Boolean(req.query.host);

    if (shop && !isEmbedded) {
      res.redirect(302, embeddedAppUrl(shop));
      return;
    }

    if (!hasBuild) {
      res
        .status(200)
        .type('text/plain')
        .send(
          'CODkar API is running.\n\n' +
            'The embedded admin is served by Vite in development — open the app ' +
            'from your Shopify admin, or run `npm run dev` at the repository root.\n',
        );
      return;
    }

    // `sendFile` rather than a static index fallback so the CSP and framing
    // headers set earlier in the stack are still on the response.
    res.sendFile(indexFile, (error) => {
      if (error) next(error);
    });
  };

  if (hasBuild) {
    app.use(
      express.static(adminDist, {
        // Vite fingerprints asset filenames, so they can be cached
        // indefinitely. index.html must never be, or a deploy leaves merchants
        // on a stale bundle pointing at assets that no longer exist.
        index: false,
        maxAge: '1y',
        immutable: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store');
          }
        },
      }),
    );
  }

  app.get('/', serveEntry);

  // Client-side routes (`/orders`, `/settings`) are rendered by the SPA, so any
  // non-API GET that reaches here must return the shell rather than a 404.
  // Scoped to GET so a stray POST still falls through to the 404 handler.
  app.get(/^\/(?!api\/).*/, serveEntry);
}

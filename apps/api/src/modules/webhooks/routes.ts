import express, { Router } from 'express';
import { verifyWebhook } from '../../middlewares/verifyWebhook';
import { webhookRateLimit } from '../../middlewares/rateLimit';
import { receive } from './controller';

/**
 * Webhook routes.
 *
 * Mounted at `/api/webhooks` and deliberately assembled before the JSON body
 * parser in `app.ts`. `express.raw` hands the handler the exact bytes Shopify
 * sent, which is what the HMAC covers — parsing to JSON first and
 * re-serializing changes key order and unicode escaping, and the signature then
 * fails in a way that looks like a wrong secret.
 *
 * A single wildcard route rather than one per topic: the topic arrives in a
 * header, so path-based routing would only duplicate information the request
 * already carries, and every new subscription in shopify.app.toml would need a
 * matching line here.
 */
export const webhookRouter: Router = Router();

webhookRouter.use(
  express.raw({
    // Shopify sends `application/json`, but a stray charset parameter or a
    // proxy that rewrites the header would fall through to the JSON parser and
    // destroy the signature. Accepting everything here is safe because nothing
    // reads the body until the HMAC has been checked.
    type: '*/*',
    // Comfortably above the largest realistic payload — a bulk order with many
    // line items runs to a few hundred kilobytes.
    limit: '2mb',
  }),
);

webhookRouter.use(webhookRateLimit);

webhookRouter.post('/{*topic}', verifyWebhook, receive);

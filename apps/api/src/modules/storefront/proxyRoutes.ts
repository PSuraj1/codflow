import { Router } from 'express';
import { verifyAppProxy } from '../../middlewares/verifyAppProxy';
import { storefrontRateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { StorefrontConfigQuerySchema } from './dto';
import { getConfig } from './controller';
import { FormQuerySchema, SubmitOrderSchema } from '../orders/dto';
import { getForm, submit } from '../orders/controller';
import { TelemetrySchema } from '../analytics/dto';
import { ingest } from '../analytics/telemetryController';
import { PostalLookupSchema } from '../postal/dto';
import { OrderStatusSchema } from '../orders/dto';
import { status as orderStatus } from '../orders/statusController';
import { lookup as postalLookup } from '../postal/controller';

/**
 * App proxy routes, mounted at `/api/proxy`.
 *
 * Same controllers as `/api/storefront`, reached a different way: the shopper's
 * browser calls `https://<shop>/apps/codflow/config` and Shopify forwards it
 * here with a signature. This is the transport the theme app extension uses,
 * because it is same-origin from the storefront — which means it works on a
 * merchant's custom domain without CORS, and without a static asset needing to
 * know the app's hostname.
 *
 * Middleware order is deliberate:
 *
 *   1. rate limit  — cheap, and keyed off the `shop` query parameter, which is
 *                    present on every proxy request before verification runs.
 *   2. verify      — the signature check. Everything after it can trust that
 *                    the request passed through a real storefront.
 *   3. validate    — strips Shopify's proxy parameters (`signature`,
 *                    `path_prefix`, `timestamp`) now that they have been used,
 *                    leaving the controller the app's own inputs only.
 */
export const proxyRouter: Router = Router();

proxyRouter.use(storefrontRateLimit);
proxyRouter.use(verifyAppProxy);

proxyRouter.get('/config', validate({ query: StorefrontConfigQuerySchema }), getConfig);

proxyRouter.get('/form', validate({ query: FormQuerySchema }), getForm);

// Order creation. The proxy signature has already established that this came
// through a real storefront; the form token established that it followed a real
// form render; the service does the rest.
proxyRouter.post('/order', validate({ body: SubmitOrderSchema }), submit);

// Storefront telemetry — the conversion rate's denominator. Carries no
// identifiers and answers 204 for everything, including an unknown shop; see
// `analytics/telemetryController` for why that is the right posture here.
proxyRouter.post('/telemetry', validate({ body: TelemetrySchema }), ingest);

// Postal code -> city and state, called as the shopper types. Behind the same
// storefront limiter as everything else here: it makes an outbound call to a
// free public API, and an unbounded one would get this app blocked rather than
// whoever abused it.
proxyRouter.get('/postal', validate({ query: PostalLookupSchema }), postalLookup);

// Polled by the form after submission so the shopper can be handed to Shopify's
// own thank-you page. Guarded by a signed token rather than by the reference,
// which is guessable — see `orders/statusController`.
proxyRouter.get('/order-status', validate({ query: OrderStatusSchema }), orderStatus);

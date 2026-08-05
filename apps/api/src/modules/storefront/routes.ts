import { Router } from 'express';
import { storefrontCors } from '../../middlewares/corsPolicy';
import { storefrontRateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { StorefrontConfigQuerySchema } from './dto';
import { getConfig } from './controller';
import { TelemetrySchema } from '../analytics/dto';
import { ingest } from '../analytics/telemetryController';
import { PostalLookupSchema } from '../postal/dto';
import { OrderStatusSchema } from '../orders/dto';
import { status as orderStatus } from '../orders/statusController';
import { lookup as postalLookup } from '../postal/controller';

/**
 * Public storefront routes, mounted at `/api/storefront`.
 *
 * CORS is open here — a merchant's storefront can be served from any custom
 * domain they have mapped, so an allowlist is not possible. That is safe only
 * because the policy sets `credentials: false`: an open origin combined with
 * credentials would let any site read a merchant's data using a visitor's
 * cookies. Nothing on this router may ever start reading cookies or a session.
 *
 * Rate limiting is keyed on shop *and* IP so one abusive visitor cannot exhaust
 * a store's allowance for everyone else shopping there.
 */
export const storefrontRouter: Router = Router();

storefrontRouter.use(storefrontCors);
storefrontRouter.use(storefrontRateLimit);

storefrontRouter.get(
  '/config',
  validate({ query: StorefrontConfigQuerySchema }),
  getConfig,
);

// The same telemetry sink as the proxy router, for a headless storefront that
// cannot use Shopify's proxy. Open CORS and credential-free like everything
// else here.
storefrontRouter.post('/telemetry', validate({ body: TelemetrySchema }), ingest);

// The same postal lookup, for a headless storefront that cannot use the proxy.
storefrontRouter.get('/postal', validate({ query: PostalLookupSchema }), postalLookup);

// Polled by the form after submission so the shopper can be handed to Shopify's
// own thank-you page. Guarded by a signed token rather than by the reference,
// which is guessable — see `orders/statusController`.
storefrontRouter.get('/order-status', validate({ query: OrderStatusSchema }), orderStatus);

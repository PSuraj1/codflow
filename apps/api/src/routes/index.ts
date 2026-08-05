import { Router } from 'express';
import { adminCors } from '../middlewares/corsPolicy';
import { adminRateLimit } from '../middlewares/rateLimit';
import { authenticateAdmin } from '../middlewares/authenticateAdmin';
import { healthRouter } from '../modules/health/routes';
import { authRouter } from '../modules/auth/routes';
import { shopRouter } from '../modules/shop/routes';
import { formsRouter } from '../modules/forms/routes';
import { buttonsRouter } from '../modules/buttons/routes';
import { ordersAdminRouter } from '../modules/orders/adminRoutes';
import { googleCallbackRouter, sheetsAdminRouter } from '../modules/sheets/routes';
import { fraudRouter } from '../modules/fraud/routes';
import { pixelsRouter } from '../modules/pixels/routes';
import { analyticsRouter } from '../modules/analytics/routes';
import { billingRouter } from '../modules/billing/routes';
import { transferRouter } from '../modules/transfer/routes';
import { upsellsRouter } from '../modules/upsells/routes';
import { storefrontRouter } from '../modules/storefront/routes';
import { proxyRouter } from '../modules/storefront/proxyRoutes';
import { scopes } from '../modules/auth/controller';

/**
 * The API route table.
 *
 * Traffic is split by trust level at the top, and each class gets its own
 * middleware stack. Keeping that split visible in one file is what makes it
 * hard to accidentally expose an admin endpoint — a route added under
 * `/api/admin` inherits authentication whether or not its author thought about
 * it, and there is no path by which a module can opt out.
 *
 * `/api/webhooks` is absent here on purpose. It needs the raw request body, so
 * it is mounted in `app.ts` ahead of the JSON parser.
 */
export const apiRouter: Router = Router();

// ---- Probes. No auth, no rate limit, no dependencies on liveness.
apiRouter.use('/health', healthRouter);

// ---- Public auth surface. Unauthenticated by necessity; rate limited inside.
apiRouter.use('/auth', authRouter);

// ---- Public storefront surface. Called by the theme extension from a
// shopper's browser, so it is unauthenticated, open-CORS and credential-free.
// Its own router applies the tighter limiter and the open CORS policy.
apiRouter.use('/storefront', storefrontRouter);

// ---- The same storefront surface, reached through Shopify's app proxy. This
// is what the theme extension actually calls; `/api/storefront` remains for
// consumers that cannot use the proxy, such as a headless storefront.
apiRouter.use('/proxy', proxyRouter);

// ---- Google's OAuth return path. Public by necessity — the merchant's browser
// arrives from accounts.google.com with no session — and protected by the
// signed `state` parameter rather than by authentication.
apiRouter.use('/google', googleCallbackRouter);

// ---- Authenticated merchant surface.
//
// Order matters: CORS answers the preflight before anything expensive runs,
// the limiter falls back to IP until authentication resolves a shop, and
// authentication comes last so a rejected request never reaches a controller.
export const adminRouter: Router = Router();

adminRouter.use(adminCors);
adminRouter.use(adminRateLimit);
adminRouter.use(authenticateAdmin);

adminRouter.get('/scopes', scopes);
adminRouter.use('/forms', formsRouter);
adminRouter.use('/buttons', buttonsRouter);
adminRouter.use('/orders', ordersAdminRouter);
adminRouter.use('/sheets', sheetsAdminRouter);
adminRouter.use('/fraud', fraudRouter);
adminRouter.use('/pixels', pixelsRouter);
adminRouter.use('/analytics', analyticsRouter);
adminRouter.use('/billing', billingRouter);
adminRouter.use('/settings', transferRouter);
adminRouter.use('/upsells', upsellsRouter);
adminRouter.use('/', shopRouter);

apiRouter.use('/admin', adminRouter);

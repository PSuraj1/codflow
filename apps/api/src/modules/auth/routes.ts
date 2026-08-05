import { Router } from 'express';
import { authRateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { ExitIframeQuerySchema, ShopQuerySchema } from './dto';
import { callback, exitIframe, install, reauthorize } from './controller';

/**
 * Public auth routes, mounted at `/api/auth`.
 *
 * All of these are unauthenticated by necessity — a merchant reaching them has
 * no session yet, which is the whole point. That makes them the app's public
 * edge alongside the storefront endpoints, so every one is rate limited and
 * every one validates `shop` before it appears in a redirect.
 *
 * `/scopes` is *not* here. It requires a session and is mounted under
 * `/api/admin` with the rest of the authenticated surface, so it cannot
 * inherit this router's unauthenticated posture by accident.
 */
export const authRouter: Router = Router();

authRouter.use(authRateLimit);

authRouter.get('/install', validate({ query: ShopQuerySchema }), install);
authRouter.get('/reauthorize', validate({ query: ShopQuerySchema }), reauthorize);
authRouter.get('/exit-iframe', validate({ query: ExitIframeQuerySchema }), exitIframe);

// Declared in shopify.app.toml's `redirect_urls`. Managed installation does not
// use it; it survives for stores carrying a cached URL from an older build.
authRouter.get('/callback', callback);
authRouter.get('/shopify/callback', callback);

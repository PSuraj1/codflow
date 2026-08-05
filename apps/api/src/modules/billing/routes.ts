import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { UpgradeUrlSchema } from './dto';
import { overview, refresh, upgradeUrl } from './controller';

/**
 * Billing routes, mounted under `/api/admin/billing`.
 *
 * No route creates or cancels a subscription — under managed pricing those are
 * Shopify-hosted flows the app has no API for. What is here is the app's half:
 * report what the merchant is on, point them at Shopify to change it, and
 * re-check when they come back.
 */
export const billingRouter: Router = Router();

billingRouter.get('/', overview);
billingRouter.post('/upgrade-url', validate({ body: UpgradeUrlSchema }), upgradeUrl);
billingRouter.post('/refresh', refresh);

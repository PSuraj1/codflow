import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import {
  UpdateBrandingSchema,
  UpdateFeesSchema,
  UpdateOnboardingSchema,
  UpdateVisibilitySchema,
} from './dto';
import {
  getBranding,
  getFees,
  getSession,
  getVisibility,
  updateBranding,
  updateFees,
  updateOnboarding,
  updateVisibility,
} from './controller';

/**
 * Shop routes, mounted under `/api/admin`.
 *
 * Authentication and rate limiting are applied by the parent router rather than
 * here, so a route added to this file cannot accidentally ship unauthenticated.
 */
export const shopRouter: Router = Router();

shopRouter.get('/session', getSession);

shopRouter.get('/shop/visibility', getVisibility);
shopRouter.patch(
  '/shop/visibility',
  validate({ body: UpdateVisibilitySchema }),
  updateVisibility,
);

shopRouter.get('/shop/branding', getBranding);
shopRouter.patch(
  '/shop/branding',
  validate({ body: UpdateBrandingSchema }),
  updateBranding,
);

shopRouter.get('/shop/fees', getFees);
shopRouter.patch('/shop/fees', validate({ body: UpdateFeesSchema }), updateFees);

shopRouter.put(
  '/shop/onboarding',
  validate({ body: UpdateOnboardingSchema }),
  updateOnboarding,
);

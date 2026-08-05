import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { ImportSettingsSchema } from './dto';
import { exportSettings, importSettings } from './controller';

/**
 * Settings transfer routes, mounted under `/api/admin/settings`.
 *
 * Authentication and rate limiting come from the parent router, so a route
 * added here cannot accidentally ship unauthenticated — which matters more on
 * this module than most, since one of these rewrites a shop's configuration.
 */
export const transferRouter: Router = Router();

transferRouter.get('/export', exportSettings);

transferRouter.post('/import', validate({ body: ImportSettingsSchema }), importSettings);

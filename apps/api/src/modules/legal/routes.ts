import { Router } from 'express';
import { index, serve } from './controller';

/**
 * Public legal pages, mounted at `/legal`.
 *
 * Outside `/api` on purpose: these URLs are typed into a Partner Dashboard
 * field and read by merchants, so `https://app.example.com/legal/privacy` is
 * the right shape and `/api/legal/privacy` is not.
 *
 * No authentication, no rate limiting beyond the app-wide default, and no
 * dependency on a database — a policy page must render even when everything
 * behind it is down.
 */
export const legalRouter: Router = Router();

legalRouter.get('/', index);
legalRouter.get('/:page', serve);

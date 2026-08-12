import { Router } from 'express';
import { index, serve, serveHelp } from './controller';

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

/**
 * Help pages, mounted at `/help`.
 *
 * A separate mount rather than another entry under `/legal` because the FAQ is
 * not a legal document. Filing it there implied a lawyer had reviewed it, and
 * a merchant sent to `/legal/faq` for "how do I show the button" is being told
 * something untrue about what they are reading.
 */
export const helpRouter: Router = Router();

helpRouter.get('/:page', serveHelp);

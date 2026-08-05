import { Router } from 'express';
import { live, ready } from './controller';

/**
 * Health routes, mounted at `/api/health`.
 *
 * Deliberately not rate limited: a platform probe fires every few seconds from
 * a small set of addresses, and throttling it would take healthy replicas out
 * of rotation. The handlers are cheap enough that the endpoint is not a useful
 * amplification target.
 */
export const healthRouter: Router = Router();

healthRouter.get('/', live);
healthRouter.get('/ready', ready);

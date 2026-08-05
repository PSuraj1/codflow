import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { AnalyticsRangeQuerySchema, BreakdownQuerySchema, RebuildStatsSchema } from './dto';
import { breakdown, funnel, health, overview, rebuild } from './controller';

/**
 * Analytics routes, mounted under `/api/admin/analytics`.
 *
 * Every read takes the same range query, so a merchant changing the date
 * selector refetches the whole screen with one shape rather than four
 * endpoints each inventing their own.
 */
export const analyticsRouter: Router = Router();

analyticsRouter.get('/overview', validate({ query: AnalyticsRangeQuerySchema }), overview);
analyticsRouter.get('/breakdown', validate({ query: BreakdownQuerySchema }), breakdown);
analyticsRouter.get('/funnel', validate({ query: AnalyticsRangeQuerySchema }), funnel);

// No range: health is the state of things right now, not over a window.
analyticsRouter.get('/health', health);

analyticsRouter.post('/rebuild', validate({ body: RebuildStatsSchema }), rebuild);

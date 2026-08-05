import type { NextFunction, Request, Response } from 'express';
import type { BreakdownDimension, RebuildStatsResult } from '@codflow/shared';
import { accepted, ok } from '../../lib/http';
import { InternalError } from '../../lib/errors';
import { daysBetween } from '../../lib/shopTime';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import { enqueueStatsRebuild } from '../../queue/queues';
import * as service from './service';
import type { AnalyticsRangeQueryInput, BreakdownQueryInput, RebuildStatsInput } from './dto';

/**
 * Analytics HTTP surface.
 *
 * Read-only apart from the rebuild, which is why there is no audit trail on
 * most of it — nothing here changes a merchant's data, and logging every
 * dashboard load would bury the entries that matter.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/** Every endpoint resolves the same range, from the same query shape. */
async function rangeFor(req: Request, shopId: string) {
  const query = req.query as unknown as AnalyticsRangeQueryInput;

  return service.resolveRange(shopId, {
    range: query.range,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  });
}

export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.overview(auth.shopId, await rangeFor(req, auth.shopId)));
  } catch (error) {
    next(error);
  }
}

export async function breakdown(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const query = req.query as unknown as BreakdownQueryInput;

    ok(
      res,
      await service.breakdown(
        auth.shopId,
        await rangeFor(req, auth.shopId),
        query.dimension as BreakdownDimension,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function funnel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.funnel(auth.shopId, await rangeFor(req, auth.shopId)));
  } catch (error) {
    next(error);
  }
}

export async function health(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.health(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/**
 * Recomputes stored aggregates from the orders themselves.
 *
 * Short windows run inline because the merchant is watching and a month is one
 * indexed query. Anything longer is handed to the worker and answered 202 —
 * holding an HTTP connection open for a year-long rebuild would hit every proxy
 * timeout between here and the browser, and the merchant would see a failure
 * for work that actually succeeded.
 */
export async function rebuild(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as RebuildStatsInput;
    const days = daysBetween(input.from, input.to);

    await audit.recordForRequest(req, {
      action: 'analytics.rebuild_requested',
      entity: 'DailyStat',
      after: { from: input.from, to: input.to, days },
    });

    if (days <= service.INLINE_REBUILD_DAYS) {
      await service.rebuild(auth.shopId, input.from, input.to);

      const result: RebuildStatsResult = { queued: false, from: input.from, to: input.to, days };
      ok(res, result);
      return;
    }

    await enqueueStatsRebuild({
      shopId: auth.shopId,
      shopDomain: auth.shopDomain,
      from: input.from,
      to: input.to,
    });

    const result: RebuildStatsResult = { queued: true, from: input.from, to: input.to, days };
    accepted(res, result);
  } catch (error) {
    next(error);
  }
}

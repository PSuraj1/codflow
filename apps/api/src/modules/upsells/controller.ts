import type { NextFunction, Request, Response } from 'express';
import { InternalError } from '../../lib/errors';
import { ok } from '../../lib/http';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as service from './service';
import type { CreateOrderBumpInput, UpdateOrderBumpInput } from './dto';

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) throw new InternalError('Route is missing the authenticateAdmin middleware');
  return req.auth;
}

/** `GET /api/admin/upsells/bumps` */
export async function listBumps(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.listBumps(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/** `POST /api/admin/upsells/bumps` */
export async function createBump(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as CreateOrderBumpInput;
    const bump = await service.createBump(auth.shopId, auth.shopDomain, input);

    await audit.recordForRequest(req, {
      action: 'upsell.bump_created',
      entity: 'OrderBump',
      entityId: bump.id,
      after: bump as unknown as Record<string, unknown>,
    });

    res.status(201);
    ok(res, bump);
  } catch (error) {
    next(error);
  }
}

/**
 * `PATCH /api/admin/upsells/bumps/:bumpId`
 *
 * Audited with both snapshots: this changes what shoppers are charged, and a
 * price that moved without explanation is a support question nobody can answer
 * from the order records alone.
 */
export async function updateBump(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const bumpId = req.params.bumpId as string;
    const input = req.body as UpdateOrderBumpInput;

    const list = await service.listBumps(auth.shopId);
    const before = list.find((entry) => entry.id === bumpId);
    const after = await service.updateBump(auth.shopId, auth.shopDomain, bumpId, input);

    await audit.recordForRequest(req, {
      action: 'upsell.bump_updated',
      entity: 'OrderBump',
      entityId: bumpId,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

/** `DELETE /api/admin/upsells/bumps/:bumpId` */
export async function deleteBump(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const bumpId = req.params.bumpId as string;

    await service.deleteBump(auth.shopId, auth.shopDomain, bumpId);

    await audit.recordForRequest(req, {
      action: 'upsell.bump_deleted',
      entity: 'OrderBump',
      entityId: bumpId,
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

import type { NextFunction, Request, Response } from 'express';
import type { CustomizableButtonPlacement } from '@codflow/shared';
import { ok } from '../../lib/http';
import { InternalError } from '../../lib/errors';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as service from './service';
import type { UpdateButtonInput } from './dto';

/**
 * COD button HTTP surface.
 *
 * The save is audited with both snapshots, because this is the screen a
 * merchant reaches for when COD orders stop arriving: switching a placement off
 * or hiding it on mobile has exactly the same symptom as the app breaking, and
 * the audit row is what separates the two.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/** `GET /api/admin/buttons` — every renderable placement, configured or not. */
export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.listButtons(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/** `PATCH /api/admin/buttons/:placement` — creates the row if there is none. */
export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const placement = req.params.placement as CustomizableButtonPlacement;
    const input = req.body as UpdateButtonInput;

    const before = await service.getButton(auth.shopId, placement);
    const after = await service.updateButton(auth.shopId, auth.shopDomain, placement, input);

    await audit.recordForRequest(req, {
      action: 'button.updated',
      entity: 'ButtonConfig',
      entityId: placement,
      before,
      after,
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

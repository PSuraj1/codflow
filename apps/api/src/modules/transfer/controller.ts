import type { NextFunction, Request, Response } from 'express';
import { InternalError } from '../../lib/errors';
import { ok } from '../../lib/http';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as service from './service';
import type { ImportSettingsInput } from './dto';

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/**
 * `GET /api/admin/settings/export`
 *
 * Sent as a download rather than as an API envelope: the merchant's next step
 * is to keep the file, and a browser that renders it as JSON in a tab is one
 * they then have to save by hand.
 */
export async function exportSettings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const payload = await service.exportSettings(auth.shopId, auth.shopDomain);

    // Dated and shop-scoped, because the first thing a merchant does with two
    // backups is try to tell them apart.
    const stamp = payload.exportedAt.slice(0, 10);
    const shop = auth.shopDomain.replace(/\.myshopify\.com$/, '');
    const filename = `codflow-settings-${shop}-${stamp}.json`;

    await audit.recordForRequest(req, {
      action: 'settings.exported',
      entity: 'Shop',
      entityId: auth.shopId,
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // A settings file is the merchant's current configuration; a cached copy
    // would hand them yesterday's backup and call it today's.
    res.setHeader('Cache-Control', 'no-store');
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /api/admin/settings/import`
 *
 * Audited with both snapshots. An import rewrites most of a merchant's
 * configuration in one action, and "everything changed and I do not know what
 * it was before" is the single worst thing this feature can do to someone —
 * the before-snapshot is what makes it recoverable.
 */
export async function importSettings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as ImportSettingsInput;

    const before = await service.exportSettings(auth.shopId, auth.shopDomain);
    const result = await service.importSettings(auth.shopId, auth.shopDomain, input);
    const after = await service.exportSettings(auth.shopId, auth.shopDomain);

    await audit.recordForRequest(req, {
      action: 'settings.imported',
      entity: 'Shop',
      entityId: auth.shopId,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });

    ok(res, result);
  } catch (error) {
    next(error);
  }
}

import type { NextFunction, Request, Response } from 'express';
import { InternalError } from '../../lib/errors';
import { ok } from '../../lib/http';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as service from './service';
import type {
  UpdateBrandingInput,
  UpdateFeesInput,
  UpdateOnboardingInput,
  UpdateVisibilityInput,
} from './dto';

/**
 * Shop HTTP surface.
 *
 * Controllers here do three things and nothing else: assert the request is
 * authenticated, hand the parsed input to a service, and shape the response.
 * No Prisma, no Shopify client, no branching on business rules — that all lives
 * a layer down, which is what lets the session-building logic be tested without
 * an HTTP server.
 */

/**
 * Narrows `req.auth` for routes mounted behind `authenticateAdmin`.
 *
 * The middleware guarantees this, but the type is optional because the same
 * Request interface serves unauthenticated routes. Throwing an internal error
 * rather than a 401 is correct: reaching here without auth is a routing bug,
 * not a client problem, and reporting it as 401 would send merchants chasing a
 * login issue that does not exist.
 */
function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/** `GET /api/admin/session` — everything the admin shell needs to render. */
export async function getSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const payload = await service.buildSessionResponse(auth);
    ok(res, payload);
  } catch (error) {
    next(error);
  }
}

/** `GET /api/admin/shop/branding` — colours, font and radius for the COD form. */
export async function getBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.getBranding(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/**
 * `PATCH /api/admin/shop/branding`
 *
 * Audited with both snapshots. Branding is the most visible thing a merchant
 * can change and the easiest to change by accident — "the form went white" is
 * answerable from an audit row and almost nothing else.
 */
export async function updateBranding(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpdateBrandingInput;

    const before = await service.getBranding(auth.shopId);
    const after = await service.updateBranding(auth.shopId, auth.shopDomain, input);

    await audit.recordForRequest(req, {
      action: 'shop.branding_updated',
      entity: 'ShopSettings',
      entityId: auth.shopId,
      before,
      after,
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

/** `GET /api/admin/shop/visibility` — where and when COD is offered. */
export async function getVisibility(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.getVisibility(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/**
 * `PATCH /api/admin/shop/visibility`
 *
 * Audited with both snapshots. Switching COD off, or restricting it to three
 * products, stops orders arriving — and looks exactly like the app breaking.
 * The audit row is what separates the two.
 */
export async function updateVisibility(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpdateVisibilityInput;

    const before = await service.getVisibility(auth.shopId);
    const after = await service.updateVisibility(auth.shopId, auth.shopDomain, input);

    await audit.recordForRequest(req, {
      action: 'shop.visibility_updated',
      entity: 'ShopSettings',
      entityId: auth.shopId,
      before,
      after,
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

/** `GET /api/admin/shop/fees` — what COD costs the shopper. */
export async function getFees(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.getFees(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/**
 * `PATCH /api/admin/shop/fees`
 *
 * Audited with both snapshots, for the same reason visibility is: these amounts
 * are added to what every shopper pays, and a delivery charge that changed
 * without explanation is a support ticket nobody can answer from the order
 * records alone.
 */
export async function updateFees(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpdateFeesInput;

    const before = await service.getFees(auth.shopId);
    const after = await service.updateFees(auth.shopId, auth.shopDomain, input);

    await audit.recordForRequest(req, {
      action: 'shop.fees_updated',
      entity: 'ShopSettings',
      entityId: auth.shopId,
      before,
      after,
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

/** `PUT /api/admin/shop/onboarding` — records progress through the setup guide. */
export async function updateOnboarding(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpdateOnboardingInput;

    const state = await service.saveOnboarding(auth.shopId, input.step, input.completed);

    await audit.recordForRequest(req, {
      action: 'shop.onboarding_updated',
      entity: 'Shop',
      entityId: auth.shopId,
      after: state,
    });

    ok(res, state);
  } catch (error) {
    next(error);
  }
}

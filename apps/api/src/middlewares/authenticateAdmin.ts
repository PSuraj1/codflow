import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createLogger } from '../lib/logger';
import { clientIp } from '../lib/http';
import { ScopesChangedError, SessionTokenError, UnauthorizedError } from '../lib/errors';
import { bindShopToContext } from './requestId';
import * as authService from '../modules/auth/service';
import * as shopRepository from '../modules/shop/repository';
import * as audit from '../modules/audit/service';

const log = createLogger('authenticate-admin');

/**
 * Gate for every `/api/admin/*` route.
 *
 * Under managed installation there is no separate install step, so this
 * middleware carries more weight than a typical auth check: the first
 * authenticated request a shop ever makes *is* its installation. Ordering
 * matters and is deliberate:
 *
 *   1. verify the session token       — cheap, rejects forgeries before any I/O
 *   2. resolve an offline session     — reuses storage; exchanges only if needed
 *   3. provision the shop             — idempotent; creates the tenant on first pass
 *   4. confirm scopes                 — after the exchange, so a merchant who has
 *                                       already re-consented is not prompted again
 *
 * Doing (4) before (2) is the classic mistake: the stored session still shows
 * the old scopes, so the app sends the merchant through consent they completed
 * a moment ago, and the loop never terminates.
 */

/**
 * Pulls the session token out of the request.
 *
 * Two transports, because App Bridge uses both. XHR and fetch carry
 * `Authorization: Bearer`; a full-page document load from the Shopify admin
 * instead arrives with `?id_token=` on the query string. Supporting only the
 * header breaks deep links into the app, which is how merchants reach it from
 * an email or a Shopify Flow notification.
 */
function extractSessionToken(req: Request): string | null {
  const header = req.get('authorization');

  if (header) {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value;
  }

  const queryToken = req.query.id_token;
  if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken;

  return null;
}

export const authenticateAdmin: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const bearer = extractSessionToken(req);

    if (!bearer) {
      // Distinct from an *invalid* token: nothing was sent at all, which means
      // the client is not App Bridge-aware rather than holding a stale token.
      throw new UnauthorizedError('Missing App Bridge session token');
    }

    const resolved = await authService.resolveSession(bearer);

    const { shop, created, reinstalled } = await shopRepository.ensureProvisioned(
      resolved.shopDomain,
      resolved.session.scope ?? null,
    );

    bindShopToContext(shop.domain, shop.id);

    if (created || reinstalled) {
      await audit.record({
        shopId: shop.id,
        action: created ? audit.AuditAction.APP_INSTALLED : audit.AuditAction.APP_REINSTALLED,
        entity: 'Shop',
        entityId: shop.id,
        actor: audit.AuditActor.MERCHANT,
        actorId: resolved.userId,
        after: { domain: shop.domain, scopes: resolved.session.scope },
        ipAddress: clientIp(req),
        userAgent: req.get('user-agent') ?? null,
      });
    }

    // Checked last, and only against the session that came back from the
    // exchange. A shortfall here means the merchant genuinely has not consented
    // to the current scope set, and only managed installation can fix it.
    if (!authService.sessionSatisfiesScopes(resolved.session)) {
      const state = authService.evaluateScopes(resolved.session.scope);
      log.warn({ shop: shop.domain, missing: state.missing }, 'Granted scopes are insufficient');
      throw new ScopesChangedError(shop.domain, [...state.missing]);
    }

    req.auth = {
      shopDomain: shop.domain,
      shopId: shop.id,
      session: resolved.session,
      token: resolved.token,
      userId: resolved.userId,
    };

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Variant that authenticates when possible but does not require it.
 *
 * For endpoints that are richer for a signed-in merchant yet must still answer
 * without one — the app's root document, which has to render a "click to open
 * in Shopify admin" page rather than a 401 when opened from a bookmark.
 */
export const authenticateAdminOptional: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const bearer = extractSessionToken(req);

  if (!bearer) {
    next();
    return;
  }

  await new Promise<void>((resolve) => {
    authenticateAdmin(req, res, (error?: unknown) => {
      // A bad token on an optional route is not an error — it just means the
      // request continues unauthenticated. Anything else still propagates,
      // because a database failure here is not something to render around.
      if (error && !(error instanceof SessionTokenError) && !(error instanceof UnauthorizedError)) {
        next(error);
        resolve();
        return;
      }
      next();
      resolve();
    });
  });
};

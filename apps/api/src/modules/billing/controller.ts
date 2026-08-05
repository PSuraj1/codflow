import type { NextFunction, Request, Response } from 'express';
import { Plan } from '@prisma/client';
import type { UpgradeUrlResponse } from '@codflow/shared';
import { ok } from '../../lib/http';
import { InternalError } from '../../lib/errors';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as service from './service';
import * as repository from './repository';
import type { UpgradeUrlInput } from './dto';

/**
 * Billing HTTP surface.
 *
 * Three endpoints, and the shape of them follows from managed pricing: the app
 * can *report* a subscription and *point at* Shopify's pricing page, but it can
 * never change what a merchant is paying. There is no `POST /subscribe` here
 * because there is no such thing to call.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/** Current plan, usage against its caps, and the catalogue to render. */
export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.overview(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/**
 * Where the upgrade button sends the merchant.
 *
 * Returns a URL rather than issuing a redirect, because the client has to open
 * it in the **top frame**. Shopify serves the pricing page with
 * `frame-ancestors 'none'`, so a 302 followed inside the app iframe produces a
 * blank panel and no error — indistinguishable, from the merchant's side, from
 * the button doing nothing.
 *
 * Audited: knowing when a merchant went to look at plans is what makes a
 * "someone changed our plan" question answerable later.
 */
export async function upgradeUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpgradeUrlInput;

    await audit.recordForRequest(req, {
      action: 'billing.pricing_page_opened',
      entity: 'Subscription',
      after: { plan: input.plan ?? null },
    });

    const result: UpgradeUrlResponse = {
      url: service.pricingPageUrl(auth.shopDomain),
      plan: (input.plan as Plan | undefined) ?? null,
    };

    ok(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * Re-checks the subscription against Shopify on demand.
 *
 * Exists for the moment the merchant returns from Shopify's pricing page: the
 * `app_subscriptions/update` webhook is the reliable path, but it can arrive
 * seconds after the merchant is already back in the app looking at their old
 * plan and wondering what they paid for. This closes that window.
 *
 * Answers with the summary either way. A failed verification keeps the cached
 * plan rather than downgrading — see `service.reconcile`.
 */
export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);

    const reconciled = await service.reconcile(auth.shopId, auth.shopDomain);
    const subscription = reconciled ?? (await repository.findByShop(auth.shopId));

    ok(res, {
      subscription: service.toSummary(subscription),
      verified: reconciled !== null,
    });
  } catch (error) {
    next(error);
  }
}

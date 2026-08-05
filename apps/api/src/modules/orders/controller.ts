import type { NextFunction, Request, Response } from 'express';
import { STOREFRONT_SHOP_HEADER, type StorefrontFormResponse } from '@codflow/shared';
import { clientIp, created, ok } from '../../lib/http';
import { requireShopDomain } from '../../lib/shopDomain';
import * as service from './service';
import type { FormQueryInput, SubmitOrderInput } from './dto';

/**
 * Public COD form and submission endpoints.
 *
 * Reached through Shopify's app proxy, so the shop has already been established
 * and verified by `verifyAppProxy` before either handler runs.
 */

/**
 * `GET /api/proxy/form` — the active form definition.
 *
 * Explicitly **not cached**. Every response carries a freshly-minted, expiring
 * form token, and a cached one would hand the same token to every shopper —
 * defeating the point of issuing it, and eventually serving one that has
 * already expired.
 */
export async function getForm(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as FormQueryInput;
    const shopDomain = requireShopDomain(req.get(STOREFRONT_SHOP_HEADER) ?? query.shop);

    const result = await service.getFormForStorefront(shopDomain, query.locale);

    res.setHeader('Cache-Control', 'no-store');

    const body: StorefrontFormResponse = {
      form: result.form,
      locale: result.locale,
      formToken: result.formToken,
    };

    ok(res, body);
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /api/proxy/order` — creates a COD order.
 *
 * The IP and user agent are captured here rather than in the service, because
 * they are properties of the HTTP request and the service is deliberately
 * testable without one. Both feed the fraud engine's velocity checks.
 */
export async function submit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const shopDomain = requireShopDomain(req.get(STOREFRONT_SHOP_HEADER));
    const input = req.body as SubmitOrderInput;

    const result = await service.submitOrder(
      {
        shopDomain,
        ipAddress: clientIp(req),
        userAgent: req.get('user-agent') ?? null,
      },
      input,
    );

    res.setHeader('Cache-Control', 'no-store');
    created(res, result);
  } catch (error) {
    next(error);
  }
}

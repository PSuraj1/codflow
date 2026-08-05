import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../lib/http';
import { prisma } from '../../db/prisma';
import { normalizeShopDomain } from '../../lib/shopDomain';
import { BadRequestError, ForbiddenError } from '../../lib/errors';
import { verifyOrderToken } from '../../lib/orderToken';
import type { OrderStatusInput } from './dto';

/**
 * Public order status, polled by the COD form after submission.
 *
 * Exists so the shopper can be handed to Shopify's own thank-you page. That
 * page needs an order-status URL, which only exists once the order has been
 * pushed — and the push is asynchronous, so the form has to wait and ask.
 *
 * **The token is what makes this safe to expose.** An order reference is not a
 * secret: `CF-XXXXXXXX` over a small alphabet is guessable, and Shopify's order
 * status page shows the customer's name, address and phone. So the reference
 * alone is never enough — a signed token, issued in the submit response to the
 * one browser that placed the order, is required and is checked against both
 * the shop and the reference it claims to cover.
 *
 * The response is deliberately thin: whether it is pushed, and where to go.
 * Nothing about the customer, the items or the total, because none of that is
 * needed to redirect and all of it would be worth stealing.
 */
export async function status(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as OrderStatusInput;
    const shopDomain = normalizeShopDomain(query.shop);

    if (!shopDomain) throw new BadRequestError('A shop domain is required');

    const verification = verifyOrderToken(query.token, shopDomain, query.reference);

    if (!verification.valid) {
      // Deliberately identical whether the token is forged, expired, or for a
      // different order: a distinguishable response would confirm which
      // references exist.
      throw new ForbiddenError('This order status link is not valid.');
    }

    const order = await prisma.codOrder.findFirst({
      where: { reference: query.reference, shop: { domain: shopDomain } },
      select: { status: true, orderStatusUrl: true, shopifyOrderNumber: true },
    });

    if (!order) {
      ok(res, { pushed: false, orderStatusUrl: null, orderNumber: null });
      return;
    }

    ok(res, {
      pushed: Boolean(order.orderStatusUrl),
      orderStatusUrl: order.orderStatusUrl,
      orderNumber: order.shopifyOrderNumber,
    });
  } catch (error) {
    next(error);
  }
}

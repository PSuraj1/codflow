import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../lib/http';
import { normalizeShopDomain } from '../../lib/shopDomain';
import { BadRequestError } from '../../lib/errors';
import * as service from './service';
import type { PostalLookupInput } from './dto';

/**
 * Postal lookup, called from the COD form as the shopper types.
 *
 * Public and unauthenticated like the rest of the storefront surface, and
 * carrying nothing worth protecting: a postal code and a country. What it does
 * expose is an outbound call to a third party, so it sits behind the storefront
 * rate limiter — otherwise it is an open proxy for hammering a free public API
 * from our address, which would get the app blocked rather than the abuser.
 */
export async function lookup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as PostalLookupInput;
    const shopDomain = normalizeShopDomain(query.shop);

    if (!shopDomain) throw new BadRequestError('A shop domain is required');

    ok(res, await service.lookup(shopDomain, query.country, query.code));
  } catch (error) {
    next(error);
  }
}

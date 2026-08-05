import type { NextFunction, Request, Response } from 'express';
import { noContent } from '../../lib/http';
import { createLogger } from '../../lib/logger';
import * as shopRepository from '../shop/repository';
import * as stats from './stats';
import type { TelemetryInput } from './dto';

const log = createLogger('telemetry');

/**
 * Storefront telemetry.
 *
 * The conversion rate needs a denominator, and the number of shoppers who *saw*
 * a COD button is the one figure in the whole dashboard that has no row in the
 * database to derive it from. Either the storefront reports it or the app can
 * never answer "what share of the people who saw this actually ordered" — which
 * is the question a merchant evaluating COD is really asking.
 *
 * The security posture follows from what is at stake. This endpoint is reached
 * from a shopper's browser through the app proxy, so it cannot be
 * authenticated. It therefore accepts nothing but a shop domain and one of
 * three event names: there is no identifier to forge, no money-side counter
 * reachable from it, and the worst a forged call achieves is inflating a
 * merchant's own funnel denominator — which makes their conversion rate look
 * *worse*, not better. Anything with a real consequence stays behind the
 * authenticated admin surface.
 *
 * It answers 204 unconditionally, including for an unknown shop. A storefront
 * beacon has nobody to report an error to, and distinguishing "shop not found"
 * from "recorded" in the response would turn this into a cheap way to enumerate
 * which domains have the app installed.
 */
export async function ingest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = req.body as TelemetryInput;
    const shop = await shopRepository.findIdByDomain(input.shop);

    if (!shop) {
      noContent(res);
      return;
    }

    switch (input.event) {
      case 'form_view':
        await stats.recordFormView(shop.id);
        break;
      case 'form_start':
        await stats.recordFormStart(shop.id);
        break;
      case 'button_click':
        await stats.recordButtonClick(shop.id);
        break;
      default:
        break;
    }

    noContent(res);
  } catch (error) {
    // A telemetry failure must never surface on a storefront. It is logged and
    // answered 204 like everything else here.
    log.warn({ err: error }, 'Telemetry ingest failed');
    next(error);
  }
}

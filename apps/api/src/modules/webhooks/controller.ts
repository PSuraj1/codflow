import type { NextFunction, Request, Response } from 'express';
import { InternalError } from '../../lib/errors';
import * as service from './service';

/**
 * Webhook HTTP surface.
 *
 * One handler for every topic. Shopify puts the topic in a header, and the
 * router mounts this on a wildcard path, so adding a subscription in
 * shopify.app.toml requires no route change here — only a processor in
 * `service.ts`.
 *
 * The response is intentionally uniform and always 200 for anything that passed
 * verification. Shopify reads the status code, not the body; a non-2xx tells it
 * to retry, and repeated non-2xx eventually disables the subscription.
 */
export async function receive(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.webhook) {
      // Unreachable via the router — `verifyWebhook` runs first and either
      // populates this or throws. A bug in middleware ordering, not user input.
      throw new InternalError('Webhook context missing — verification middleware did not run');
    }

    const result = await service.dispatch(req.webhook);

    // Answered before any expensive follow-up work would run, which is what
    // keeps this inside Shopify's 5 second budget.
    res.status(200).json({
      received: true,
      duplicate: result.duplicate,
      handled: result.handled,
    });
  } catch (error) {
    // Only reachable if the receipt write itself failed — the database is down.
    // That one *is* worth a 500: Shopify's retry is the recovery mechanism,
    // because nothing was durably stored.
    next(error);
  }
}

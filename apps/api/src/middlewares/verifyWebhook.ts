import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { shopify } from '../shopify/client';
import { createLogger } from '../lib/logger';
import { normalizeShopDomain } from '../lib/shopDomain';
import { WebhookVerificationError, toError } from '../lib/errors';

const log = createLogger('verify-webhook');

/**
 * HMAC verification for incoming Shopify webhooks.
 *
 * This is the only thing standing between the public internet and the order
 * pipeline — a forged `orders/create` would create COD records, fire purchase
 * events at Meta's Conversions API and write rows into a merchant's Google
 * Sheet. So verification happens before anything else reads the body.
 *
 * The webhook router mounts `express.raw()` rather than `express.json()`,
 * because the signature covers the exact bytes Shopify sent. Parsing to JSON
 * and re-serializing changes key order and unicode escaping, and the HMAC then
 * fails for reasons that look like a misconfigured secret. Reading the raw
 * buffer avoids that entirely.
 */

/** Shopify sends `ORDERS_CREATE`; the rest of the app uses `orders/create`. */
function normalizeTopic(topic: string): string {
  return topic.toLowerCase().replace(/_/g, '/');
}

function parseTriggeredAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const verifyWebhook: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;

    if (!rawBody || rawBody.length === 0) {
      throw new WebhookVerificationError('empty body');
    }

    req.rawBody = rawBody;

    const result = await shopify.webhooks.validate({
      rawBody: rawBody.toString('utf8'),
      rawRequest: req,
      rawResponse: res,
    });

    if (!result.valid) {
      // Logged at warn, not error: a failure here is either an attack or the
      // merchant clicking "send test notification" in Shopify's notification
      // settings, which is signed with a different secret and always fails.
      log.warn(
        { reason: result.reason, shop: req.get('x-shopify-shop-domain') ?? null },
        'Webhook rejected',
      );
      throw new WebhookVerificationError(result.reason);
    }

    const shopDomain = normalizeShopDomain(result.domain);

    if (!shopDomain) {
      // The HMAC is valid, so this came from Shopify — but a shop domain that
      // fails sanitization would poison every lookup keyed on it.
      throw new WebhookVerificationError(`unusable shop domain "${result.domain}"`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new WebhookVerificationError(`body is not valid JSON: ${toError(error).message}`);
    }

    req.webhook = {
      topic: normalizeTopic(result.topic),
      shopDomain,
      webhookId: result.webhookId,
      apiVersion: result.apiVersion,
      triggeredAt: parseTriggeredAt(result.triggeredAt),
      subTopic: 'subTopic' in result ? (result.subTopic ?? null) : null,
      payload,
    };

    next();
  } catch (error) {
    next(error);
  }
};

import { createHmac } from 'node:crypto';
import type { PixelEventName } from '@codflow/shared';
import { config } from '../../config/env';
import {
  classify,
  fetchWithTimeout,
  networkFailure,
  type DispatchResult,
  type PixelEventPayload,
  type Provider,
  type ProviderConfig,
} from '../types';

/**
 * A merchant's own endpoint.
 *
 * For anything CODkar does not integrate with directly — a data warehouse, a
 * self-hosted analytics stack, an in-house attribution service.
 *
 * The payload is **signed**. A merchant receiving conversion data on a public
 * URL otherwise has no way to tell a real event from anyone who guessed the
 * address, and conversion data is exactly the sort of thing worth poisoning if
 * you want to distort a competitor's ad spend. The signature is an HMAC over
 * the raw body using the app's session secret, which the merchant can verify.
 *
 * Deliberately **no hashed identifiers**. Advanced matching exists so an ad
 * platform can recognise a person it already knows; a merchant's own endpoint
 * gains nothing from a SHA-256 of an email it could store in the clear, and
 * shipping hashes there spreads shopper PII derivatives further than they need
 * to go.
 */

export const customProvider: Provider = {
  provider: 'CUSTOM',

  // A merchant's own endpoint accepts whatever they decide to handle.
  supports(_eventName: PixelEventName): boolean {
    return true;
  },

  async send(providerConfig: ProviderConfig, payload: PixelEventPayload): Promise<DispatchResult> {
    const endpoint = providerConfig.endpoint ?? providerConfig.pixelId;

    if (!endpoint || !/^https:\/\//i.test(endpoint)) {
      return {
        ok: false,
        httpStatus: null,
        message: 'A custom pixel needs an https endpoint to post to.',
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const body = JSON.stringify({
      event: payload.customEventName ?? payload.eventName,
      eventId: payload.eventId,
      eventTime: payload.eventTime,
      orderReference: payload.orderReference,
      value: payload.value,
      currency: payload.currency,
      contents: payload.contents,
      sourceUrl: payload.sourceUrl,
      // Click identifiers only — these are already public in the shopper's own
      // URL and cookies, unlike the hashed personal details.
      click: {
        fbp: payload.fbp,
        fbc: payload.fbc,
        ttclid: payload.ttclid,
        gclid: payload.gclid,
      },
    });

    const signature = createHmac('sha256', config.security.sessionSecret).update(body).digest('hex');

    try {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CodFlow-Signature': `sha256=${signature}`,
          'X-CodFlow-Event': payload.customEventName ?? payload.eventName,
          'User-Agent': 'CODkar/1.0',
        },
        body,
      });

      const text = await response.text();
      const { ok, retriable } = classify(response.status);

      return {
        ok,
        httpStatus: response.status,
        message: ok ? 'Delivered to your endpoint' : `Your endpoint returned ${response.status}`,
        matchQuality: null,
        retriable,
        responseBody: text.slice(0, 1_000),
      };
    } catch (error) {
      return networkFailure(error);
    }
  },
};

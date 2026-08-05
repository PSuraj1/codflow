import { PROVIDER_EVENT_NAMES, type PixelEventName } from '@codflow/shared';
import { compact } from '../matching';
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
 * TikTok Events API.
 *
 * Structurally close to Meta's, with three differences that matter:
 *
 *  - The access token goes in an `Access-Token` header, not the query string.
 *  - A purchase is `CompletePayment`, not `Purchase`. Sending `Purchase` is
 *    accepted and recorded as a custom event that no campaign optimises
 *    against — it looks like it worked.
 *  - TikTok signals failure in the *body* (`code` non-zero) while still
 *    returning HTTP 200, so the status alone is not enough to tell whether the
 *    event landed.
 */

const ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

export const tiktokProvider: Provider = {
  provider: 'TIKTOK',

  supports(eventName: PixelEventName): boolean {
    return Boolean(PROVIDER_EVENT_NAMES.TIKTOK[eventName]);
  },

  async send(config: ProviderConfig, payload: PixelEventPayload): Promise<DispatchResult> {
    if (!config.accessToken) {
      return {
        ok: false,
        httpStatus: null,
        message: 'No Events API access token is configured for this pixel.',
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const eventName = PROVIDER_EVENT_NAMES.TIKTOK[payload.eventName] ?? payload.customEventName;

    if (!eventName) {
      return {
        ok: false,
        httpStatus: null,
        message: `TikTok has no equivalent for ${payload.eventName}.`,
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const body = {
      event_source: 'web',
      event_source_id: config.pixelId,
      ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
      data: [
        compact({
          event: eventName,
          event_time: payload.eventTime,
          event_id: payload.eventId,
          user: compact({
            // TikTok expects SHA-256 hex, same as Meta.
            email: payload.matching.email,
            phone: payload.matching.phone,
            first_name: payload.matching.firstName,
            last_name: payload.matching.lastName,
            city: payload.matching.city,
            state: payload.matching.state,
            zip_code: payload.matching.zip,
            country: payload.matching.country,
            external_id: payload.externalId,
            // Unhashed, like Meta's fbp/fbc.
            ttclid: payload.ttclid,
            ip: payload.clientIpAddress,
            user_agent: payload.clientUserAgent,
          }),
          properties: compact({
            currency: payload.currency,
            value: payload.value,
            order_id: payload.orderReference,
            contents: payload.contents.map((item) => ({
              content_id: item.id,
              content_name: item.title,
              quantity: item.quantity,
              price: item.price,
            })),
            content_type: 'product',
          }),
          page: compact({ url: payload.sourceUrl }),
        }),
      ],
    };

    try {
      const response = await fetchWithTimeout(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': config.accessToken,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      let { ok, retriable } = classify(response.status);
      let message = ok ? 'Accepted by TikTok' : `TikTok returned ${response.status}`;

      try {
        const parsed = JSON.parse(text) as { code?: number; message?: string };

        // A non-zero `code` on an HTTP 200 is a rejection. Trusting the status
        // alone would report every malformed payload as delivered.
        if (typeof parsed.code === 'number' && parsed.code !== 0) {
          ok = false;
          // 40100 and friends are auth or validation failures; retrying will
          // fail identically.
          retriable = parsed.code >= 50000;
          message = parsed.message ?? `TikTok rejected the event (code ${parsed.code})`;
        } else if (ok) {
          message = 'Accepted by TikTok';
        }
      } catch {
        // Non-JSON body — treat the HTTP status as authoritative.
      }

      return {
        ok,
        httpStatus: response.status,
        message,
        matchQuality: null,
        retriable,
        responseBody: text.slice(0, 1_000),
      };
    } catch (error) {
      return networkFailure(error);
    }
  },
};

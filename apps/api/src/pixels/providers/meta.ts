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
 * Meta Conversions API.
 *
 * The best-documented of the providers and the one merchants care most about.
 * Three details are easy to get wrong and produce a 200 response that does
 * nothing:
 *
 *  - `event_id` must match the browser event exactly, or the conversion is
 *    counted twice.
 *  - `action_source` must be `website`. Anything else changes how Meta
 *    attributes the conversion, and `website` is what a COD form submitted in a
 *    browser actually is — even though the Purchase is emitted later by the
 *    server.
 *  - User data must be hashed *except* `fbp`, `fbc`, `client_ip_address` and
 *    `client_user_agent`. Hashing those breaks matching entirely, and Meta does
 *    not complain.
 */

// Pinned rather than tracking the newest release: Meta occasionally changes
// required fields between versions, and a silent drop in match quality is much
// harder to notice than a version bump.
const API_VERSION = 'v21.0';

export const metaProvider: Provider = {
  provider: 'META',

  supports(eventName: PixelEventName): boolean {
    return Boolean(PROVIDER_EVENT_NAMES.META[eventName]);
  },

  async send(config: ProviderConfig, payload: PixelEventPayload): Promise<DispatchResult> {
    if (!config.accessToken) {
      return {
        ok: false,
        httpStatus: null,
        message: 'No Conversions API access token is configured for this pixel.',
        matchQuality: null,
        // A missing credential is not fixed by trying again.
        retriable: false,
        responseBody: null,
      };
    }

    const eventName = PROVIDER_EVENT_NAMES.META[payload.eventName] ?? payload.customEventName;

    if (!eventName) {
      return {
        ok: false,
        httpStatus: null,
        message: `Meta has no equivalent for ${payload.eventName}.`,
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const userData = compact({
      // Meta's field names are abbreviations: em, ph, fn, ln, ct, st, zp,
      // country. All SHA-256 hex, all lowercase.
      em: payload.matching.email,
      ph: payload.matching.phone,
      fn: payload.matching.firstName,
      ln: payload.matching.lastName,
      ct: payload.matching.city,
      st: payload.matching.state,
      zp: payload.matching.zip,
      country: payload.matching.country,
      // Deliberately unhashed — these are Meta's own identifiers and hashing
      // them makes matching worse, silently.
      fbp: payload.fbp,
      fbc: payload.fbc,
      client_ip_address: payload.clientIpAddress,
      client_user_agent: payload.clientUserAgent,
      external_id: payload.externalId,
    });

    const body = {
      data: [
        compact({
          event_name: eventName,
          event_time: payload.eventTime,
          event_id: payload.eventId,
          event_source_url: payload.sourceUrl,
          action_source: 'website',
          user_data: userData,
          custom_data: compact({
            currency: payload.currency,
            value: payload.value,
            order_id: payload.orderReference,
            contents: payload.contents.map((item) => ({
              id: item.id,
              quantity: item.quantity,
              item_price: item.price,
            })),
            content_type: 'product',
            num_items: payload.contents.reduce((sum, item) => sum + item.quantity, 0),
          }),
        }),
      ],
      // Routes the event to Events Manager' test tab instead of production
      // reporting. Present only while a merchant is testing.
      ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
    };

    const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(config.pixelId)}/events?access_token=${encodeURIComponent(config.accessToken)}`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      const { ok, retriable } = classify(response.status);

      let message = ok ? 'Accepted by Meta' : `Meta returned ${response.status}`;

      try {
        const parsed = JSON.parse(text) as {
          events_received?: number;
          messages?: string[];
          error?: { message?: string };
          fbtrace_id?: string;
        };

        if (parsed.error?.message) message = parsed.error.message;
        if (ok && typeof parsed.events_received === 'number') {
          message = `Meta received ${parsed.events_received} event(s)`;
        }
      } catch {
        // Meta occasionally answers with an HTML error page behind a proxy.
      }

      return {
        ok,
        httpStatus: response.status,
        message,
        // Meta reports match quality in Events Manager, not in the API
        // response. Reporting a number here would mean inventing one.
        matchQuality: null,
        retriable,
        responseBody: text.slice(0, 1_000),
      };
    } catch (error) {
      return networkFailure(error);
    }
  },
};

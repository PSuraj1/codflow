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
 * Snapchat Conversions API.
 *
 * Follows Meta's shape closely — Snap modelled theirs on it — with the
 * identifiers under `user_data` and the same SHA-256 normalization. The event
 * vocabulary is upper snake case (`ADD_CART`, not `AddToCart`).
 */

const ENDPOINT = 'https://tr.snapchat.com/v3';

export const snapchatProvider: Provider = {
  provider: 'SNAPCHAT',

  supports(eventName: PixelEventName): boolean {
    return Boolean(PROVIDER_EVENT_NAMES.SNAPCHAT[eventName]);
  },

  async send(config: ProviderConfig, payload: PixelEventPayload): Promise<DispatchResult> {
    if (!config.accessToken) {
      return {
        ok: false,
        httpStatus: null,
        message: 'No Conversions API access token is configured for this pixel.',
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const eventName = PROVIDER_EVENT_NAMES.SNAPCHAT[payload.eventName] ?? payload.customEventName;

    if (!eventName) {
      return {
        ok: false,
        httpStatus: null,
        message: `Snapchat has no equivalent for ${payload.eventName}.`,
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const body = {
      data: [
        compact({
          event_name: eventName,
          event_time: payload.eventTime * 1_000,
          event_id: payload.eventId,
          event_source_url: payload.sourceUrl,
          action_source: 'WEB',
          user_data: compact({
            em: payload.matching.email,
            ph: payload.matching.phone,
            fn: payload.matching.firstName,
            ln: payload.matching.lastName,
            ct: payload.matching.city,
            st: payload.matching.state,
            zp: payload.matching.zip,
            country: payload.matching.country,
            client_ip_address: payload.clientIpAddress,
            client_user_agent: payload.clientUserAgent,
            external_id: payload.externalId,
          }),
          custom_data: compact({
            currency: payload.currency,
            value: payload.value,
            order_id: payload.orderReference,
            num_items: payload.contents.reduce((sum, item) => sum + item.quantity, 0),
            content_ids: payload.contents.map((item) => item.id),
          }),
        }),
      ],
    };

    const url = `${ENDPOINT}/${encodeURIComponent(config.pixelId)}/events?access_token=${encodeURIComponent(config.accessToken)}`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      const { ok, retriable } = classify(response.status);

      return {
        ok,
        httpStatus: response.status,
        message: ok ? 'Accepted by Snapchat' : `Snapchat returned ${response.status}`,
        matchQuality: null,
        retriable,
        responseBody: text.slice(0, 1_000),
      };
    } catch (error) {
      return networkFailure(error);
    }
  },
};

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
 * Pinterest Conversions API.
 *
 * Uses lowercase snake-case event names and puts the identifiers under
 * `user_data`, each as an *array* of hashes rather than a scalar — a shape no
 * other provider uses, and one Pinterest rejects if you send a bare string.
 */

const ENDPOINT = 'https://api.pinterest.com/v5/ad_accounts';

/** Pinterest expects every hashed identifier wrapped in an array. */
function wrap(value: string | null): string[] | null {
  return value ? [value] : null;
}

export const pinterestProvider: Provider = {
  provider: 'PINTEREST',

  supports(eventName: PixelEventName): boolean {
    return Boolean(PROVIDER_EVENT_NAMES.PINTEREST[eventName]);
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

    // Pinterest addresses events to an ad account, not to the tag. The tag id
    // travels inside the event instead.
    const adAccountId = config.conversionId;

    if (!adAccountId) {
      return {
        ok: false,
        httpStatus: null,
        message: 'Pinterest needs your ad account ID to send conversions server-side.',
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const eventName = PROVIDER_EVENT_NAMES.PINTEREST[payload.eventName] ?? payload.customEventName;

    if (!eventName) {
      return {
        ok: false,
        httpStatus: null,
        message: `Pinterest has no equivalent for ${payload.eventName}.`,
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    const body = {
      data: [
        compact({
          event_name: eventName,
          action_source: 'web',
          event_time: payload.eventTime,
          event_id: payload.eventId,
          event_source_url: payload.sourceUrl,
          user_data: compact({
            em: wrap(payload.matching.email),
            ph: wrap(payload.matching.phone),
            fn: wrap(payload.matching.firstName),
            ln: wrap(payload.matching.lastName),
            ct: wrap(payload.matching.city),
            st: wrap(payload.matching.state),
            zp: wrap(payload.matching.zip),
            country: wrap(payload.matching.country),
            external_id: wrap(payload.externalId),
            client_ip_address: payload.clientIpAddress,
            client_user_agent: payload.clientUserAgent,
          }),
          custom_data: compact({
            currency: payload.currency,
            value: payload.value === null ? null : String(payload.value),
            order_id: payload.orderReference,
            num_items: payload.contents.reduce((sum, item) => sum + item.quantity, 0),
            content_ids: payload.contents.map((item) => item.id),
          }),
        }),
      ],
    };

    const url = `${ENDPOINT}/${encodeURIComponent(adAccountId)}/events${config.testEventCode ? '?test=true' : ''}`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      const { ok, retriable } = classify(response.status);

      return {
        ok,
        httpStatus: response.status,
        message: ok ? 'Accepted by Pinterest' : `Pinterest returned ${response.status}`,
        matchQuality: null,
        retriable,
        responseBody: text.slice(0, 1_000),
      };
    } catch (error) {
      return networkFailure(error);
    }
  },
};

import type { PixelEventName } from '@codflow/shared';
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
 * Google Ads conversions.
 *
 * The odd one out. Google's server-side conversion APIs each require something
 * CODkar cannot reasonably ask a merchant for:
 *
 *  - The **Google Ads API** needs OAuth against their ads account plus a
 *    developer token that Google approves per application.
 *  - **Enhanced conversions for leads** needs the same.
 *
 * What *is* reachable with only the identifiers a merchant can paste in is the
 * Measurement Protocol, which posts to a GA4 property and lets Google Ads
 * import the conversion from there. That is the path taken here, and it is
 * genuinely narrower than Meta's — so the admin says so rather than implying
 * parity.
 *
 * `conversionId` holds the GA4 measurement id (`G-XXXXXXX`) and
 * `conversionLabel` the API secret, reusing the columns the schema already has
 * rather than adding provider-specific ones.
 */

const ENDPOINT = 'https://www.google-analytics.com/mp/collect';

export const googleAdsProvider: Provider = {
  provider: 'GOOGLE_ADS',

  supports(eventName: PixelEventName): boolean {
    // Only the events a Google Ads conversion action is normally built on.
    return eventName === 'PURCHASE' || eventName === 'LEAD' || eventName === 'INITIATE_CHECKOUT';
  },

  async send(config: ProviderConfig, payload: PixelEventPayload): Promise<DispatchResult> {
    const measurementId = config.conversionId ?? config.pixelId;
    const apiSecret = config.accessToken ?? config.conversionLabel;

    if (!measurementId || !apiSecret) {
      return {
        ok: false,
        httpStatus: null,
        message:
          'Google needs a GA4 measurement ID and an API secret. Add both to send conversions server-side.',
        matchQuality: null,
        retriable: false,
        responseBody: null,
      };
    }

    /**
     * The Measurement Protocol requires a client id. The storefront's GA client
     * id is forwarded when available; without one Google still accepts the
     * event but cannot join it to a session, so attribution is weaker. Falling
     * back to the order reference keeps events distinct rather than collapsing
     * every order onto one synthetic user.
     */
    const clientId = payload.externalId ?? `codflow.${payload.orderReference}`;

    const eventName =
      payload.eventName === 'PURCHASE'
        ? 'purchase'
        : payload.eventName === 'INITIATE_CHECKOUT'
          ? 'begin_checkout'
          : 'generate_lead';

    const body = {
      client_id: clientId,
      // Microseconds, and Google rejects anything older than 72 hours.
      timestamp_micros: payload.eventTime * 1_000_000,
      non_personalized_ads: false,
      events: [
        {
          name: eventName,
          params: {
            transaction_id: payload.orderReference,
            currency: payload.currency ?? undefined,
            value: payload.value ?? undefined,
            // Google's own deduplication key for imported conversions.
            engagement_time_msec: 1,
            session_id: payload.eventId,
            items: payload.contents.map((item) => ({
              item_id: item.id,
              item_name: item.title,
              quantity: item.quantity,
              price: item.price,
            })),
          },
        },
      ],
    };

    const url = `${ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

    try {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      const { ok, retriable } = classify(response.status);

      /**
       * The Measurement Protocol answers 204 for both a valid event and a
       * malformed one — it validates nothing on the production endpoint. So a
       * success here means "Google accepted the request", not "the conversion
       * will appear", and the message says exactly that rather than
       * overpromising.
       */
      return {
        ok,
        httpStatus: response.status,
        message: ok
          ? 'Sent to Google. The Measurement Protocol does not confirm conversions — check GA4 DebugView.'
          : `Google returned ${response.status}`,
        matchQuality: null,
        retriable,
        responseBody: text.slice(0, 1_000),
      };
    } catch (error) {
      return networkFailure(error);
    }
  },
};

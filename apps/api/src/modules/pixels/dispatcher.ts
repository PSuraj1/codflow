import { PixelDispatchStatus, type CodOrder, type Pixel } from '@prisma/client';
import {
  MONETARY_EVENTS,
  SERVER_SIDE_EVENTS,
  USAGE_METRICS,
  type PixelEventName,
} from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import { buildMatching } from '../../pixels/matching';
import { providerFor } from '../../pixels/providers';
import type { PixelEventPayload, ProviderConfig } from '../../pixels/types';
import type { ResolvedLineItem } from '../orders/pricing';
import * as stats from '../analytics/stats';
import * as billing from '../billing/service';
import * as repository from './repository';

const log = createLogger('pixel-dispatcher');

/**
 * Server-side event dispatch.
 *
 * Builds one neutral event from an order and hands it to every eligible pixel.
 * Three gates decide eligibility, in this order, and each has a different
 * consequence when it stops an event:
 *
 *  1. **Consent.** Firing a marketing event for a shopper who declined is a
 *     privacy violation and an app-listing risk. Recorded as SKIPPED_CONSENT so
 *     a merchant looking at a low event count can see why rather than assuming
 *     the integration is broken.
 *  2. **Deduplication.** Already sent — recorded as DEDUPLICATED and dropped.
 *  3. **Provider support.** Not every platform has an equivalent for every
 *     event. Recorded as SKIPPED rather than sent as a custom event nothing
 *     optimises against.
 */

/**
 * The event id shared with the browser.
 *
 * Derived from the order reference and the event name rather than random, which
 * is what makes it reproducible: the storefront computes the same value for its
 * client-side event, so the provider sees two reports of one action and keeps
 * one. A random id here would double-count every conversion.
 */
export function buildEventId(orderReference: string, eventName: PixelEventName): string {
  return `${orderReference}-${eventName}`.toLowerCase();
}

/** Whether a shopper's recorded consent permits this pixel to fire. */
function consentAllows(pixel: Pixel, order: CodOrder): boolean {
  if (!pixel.requireConsent) return true;
  // Marketing consent is the relevant one — these are advertising pixels, not
  // first-party analytics.
  return order.marketingConsent;
}

function lineItemsOf(order: CodOrder): ResolvedLineItem[] {
  return Array.isArray(order.lineItems) ? (order.lineItems as unknown as ResolvedLineItem[]) : [];
}

/** Builds the neutral payload once, so every provider sees identical data. */
export function buildPayload(
  order: CodOrder,
  eventName: PixelEventName,
  sourceUrl: string | null,
): PixelEventPayload {
  const items = lineItemsOf(order);
  const carriesValue = MONETARY_EVENTS.includes(eventName);

  return {
    eventName,
    customEventName: null,
    eventId: buildEventId(order.reference, eventName),
    // Seconds. Providers reject events more than a few days old, and the order
    // timestamp is the honest one — a retry days later should still describe
    // when the purchase happened.
    eventTime: Math.floor(order.createdAt.getTime() / 1_000),
    sourceUrl: sourceUrl ?? order.landingPage,

    // Sending a value on a non-monetary event inflates reported return: a
    // ViewContent worth the order total would make browsing look as profitable
    // as buying.
    value: carriesValue ? Number(order.total) : null,
    currency: carriesValue ? order.currency : null,
    orderReference: order.reference,

    contents: items.map((item) => ({
      id: item.variantGid.split('/').pop() ?? item.variantGid,
      quantity: item.quantity,
      price: Number(item.price),
      title: item.title,
    })),

    matching: buildMatching({
      email: order.email,
      phone: order.phoneE164 ?? order.phone,
      firstName: order.firstName,
      lastName: order.lastName,
      city: order.city,
      state: order.province,
      zip: order.postalCode,
      country: order.countryCode,
    }),

    clientIpAddress: order.ipAddress,
    clientUserAgent: order.userAgent,
    fbp: order.fbp,
    fbc: order.fbc,
    ttclid: order.ttclid,
    gclid: order.gclid,
    externalId: order.clientId,
  };
}

function toProviderConfig(pixel: Pixel): ProviderConfig {
  return {
    pixelId: pixel.pixelId,
    accessToken: repository.decryptAccessToken(pixel),
    testEventCode: pixel.testEventCode,
    conversionId: pixel.conversionId,
    conversionLabel: pixel.conversionLabel,
    advancedMatching: pixel.advancedMatching,
    // The CUSTOM provider stores its endpoint in `pixelId`.
    endpoint: pixel.provider === 'CUSTOM' ? pixel.pixelId : null,
  };
}

export interface DispatchSummary {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  /** True when at least one failure is worth another attempt. */
  readonly shouldRetry: boolean;
}

/**
 * Dispatches one event to every eligible pixel.
 *
 * Providers run concurrently — they are independent HTTP calls to different
 * platforms, and doing them in sequence would make a five-pixel shop wait for
 * five round trips. `allSettled` keeps one provider's outage from discarding
 * the others' results.
 */
export async function dispatch(
  codOrderId: string,
  eventName: PixelEventName,
  attempt = 1,
): Promise<DispatchSummary> {
  const order = await repository.findOrder(codOrderId);

  if (!order) {
    log.info({ codOrderId }, 'Order no longer exists — nothing to report');
    return { sent: 0, failed: 0, skipped: 0, shouldRetry: false };
  }

  if (!SERVER_SIDE_EVENTS.includes(eventName)) {
    // Page views and searches are browser-only by nature. Claiming to send them
    // from the server would be a lie.
    log.warn({ eventName }, 'Event is not one CODkar can observe server-side');
    return { sent: 0, failed: 0, skipped: 0, shouldRetry: false };
  }

  const pixels = await repository.listServerSidePixels(order.shopId);

  if (pixels.length === 0) {
    return { sent: 0, failed: 0, skipped: 0, shouldRetry: false };
  }

  const payload = buildPayload(order, eventName, null);

  const results = await Promise.allSettled(
    pixels.map((pixel) => dispatchToPixel(pixel, order, eventName, payload, attempt)),
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let shouldRetry = false;

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      failed += 1;
      shouldRetry = true;
      log.error(
        { err: toError(result.reason), pixel: pixels[index]?.label },
        'Pixel dispatch threw unexpectedly',
      );
      continue;
    }

    if (result.value === 'sent') sent += 1;
    else if (result.value === 'skipped') skipped += 1;
    else {
      failed += 1;
      if (result.value === 'retriable') shouldRetry = true;
    }
  }

  // Counted per dispatch rather than per provider so the dashboard's "events
  // sent" matches what the merchant would count in the activity log. Skipped
  // events are deliberately in neither column: a pixel that correctly declined
  // to fire without consent has not failed.
  await stats.recordPixelEvents(order.shopId, sent, failed);

  // Metered on what was actually transmitted. A skipped event consumed no
  // provider quota and no allowance of the merchant's either.
  await billing.recordUsage(order.shopId, USAGE_METRICS.PIXEL_EVENTS, sent + failed);

  log.info(
    { codOrderId, eventName, sent, failed, skipped, reference: order.reference },
    'Pixel event dispatched',
  );

  return { sent, failed, skipped, shouldRetry };
}

type PixelOutcome = 'sent' | 'skipped' | 'retriable' | 'failed';

async function dispatchToPixel(
  pixel: Pixel,
  order: CodOrder,
  eventName: PixelEventName,
  payload: PixelEventPayload,
  attempt: number,
): Promise<PixelOutcome> {
  const base = {
    shopId: order.shopId,
    pixelId: pixel.id,
    codOrderId: order.id,
    eventName,
    customEventName: null,
    eventId: payload.eventId,
    source: 'server',
    attempt,
  } as const;

  // ---- 1. Consent
  if (!consentAllows(pixel, order)) {
    await repository.logEvent({ ...base, status: PixelDispatchStatus.SKIPPED_CONSENT });
    return 'skipped';
  }

  // ---- 2. The pixel may narrow which events it reports.
  if (pixel.enabledEvents.length > 0 && !pixel.enabledEvents.includes(eventName)) {
    await repository.logEvent({ ...base, status: PixelDispatchStatus.SKIPPED });
    return 'skipped';
  }

  // ---- 3. Already delivered
  if (pixel.deduplication && (await repository.alreadyDispatched(pixel.id, payload.eventId))) {
    await repository.logEvent({ ...base, status: PixelDispatchStatus.DEDUPLICATED });
    return 'skipped';
  }

  const provider = providerFor(pixel.provider);

  if (!provider || !provider.supports(eventName)) {
    await repository.logEvent({
      ...base,
      status: PixelDispatchStatus.SKIPPED,
      errorMessage: `${pixel.provider} has no equivalent for ${eventName}`,
    });
    return 'skipped';
  }

  const result = await provider.send(toProviderConfig(pixel), payload);

  await repository.logEvent({
    ...base,
    status: result.ok ? PixelDispatchStatus.SENT : PixelDispatchStatus.FAILED,
    responseCode: result.httpStatus,
    responseBody: result.responseBody,
    errorMessage: result.ok ? null : result.message,
    value: payload.value,
    currency: payload.currency,
  });

  await repository.recordDispatchOutcome(pixel.id, result.ok, result.message);

  if (result.ok) return 'sent';
  return result.retriable ? 'retriable' : 'failed';
}

import { PixelDispatchStatus, type Pixel, type PixelEventName } from '@prisma/client';
import {
  SERVER_SIDE_PROVIDERS,
  type PixelEventSummary,
  type PixelSummary,
  type PixelTestResult,
  type StorefrontPixel,
} from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { invalidateTag, shopTag } from '../../lib/cache';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { buildMatching } from '../../pixels/matching';
import { providerFor } from '../../pixels/providers';
import type { PixelEventPayload } from '../../pixels/types';
import { assertCanCreate, assertFeature } from '../billing/limits';
import * as repository from './repository';

const log = createLogger('pixels-service');

/**
 * Pixel configuration.
 *
 * The invariant this module holds is that **an access token never leaves the
 * server**. Every merchant-facing shape reports `hasAccessToken` instead, and
 * the storefront payload has no field for one at all — a Conversions API token
 * on a public endpoint would let anyone write conversions into the merchant's
 * ad account.
 */

function toSummary(pixel: Pixel): PixelSummary {
  return {
    id: pixel.id,
    provider: pixel.provider,
    label: pixel.label,
    pixelId: pixel.pixelId,
    isEnabled: pixel.isEnabled,
    clientSideEnabled: pixel.clientSideEnabled,
    serverSideEnabled: pixel.serverSideEnabled,
    // The token itself is deliberately absent.
    hasAccessToken: Boolean(pixel.accessTokenEnc),
    testEventCode: pixel.testEventCode,
    conversionLabel: pixel.conversionLabel,
    conversionId: pixel.conversionId,
    gtmContainerId: pixel.gtmContainerId,
    advancedMatching: pixel.advancedMatching,
    deduplication: pixel.deduplication,
    requireConsent: pixel.requireConsent,
    enabledEvents: pixel.enabledEvents,
    lastEventAt: pixel.lastEventAt?.toISOString() ?? null,
    totalSent: pixel.totalSent,
    totalFailed: pixel.totalFailed,
    lastError: pixel.lastError,
  };
}

export async function listPixels(shopId: string): Promise<PixelSummary[]> {
  return (await repository.listPixels(shopId)).map(toSummary);
}

/**
 * Validates a configuration before it is saved.
 *
 * These are the mistakes that produce a pixel which looks configured and does
 * nothing — the worst failure mode, because a merchant only discovers it when
 * they check their ad reporting weeks later.
 */
function assertCoherent(input: {
  provider: Pixel['provider'];
  serverSideEnabled: boolean;
  accessToken?: string | null;
  hasExistingToken?: boolean;
  pixelId: string;
}): void {
  if (input.serverSideEnabled && !SERVER_SIDE_PROVIDERS.includes(input.provider)) {
    throw new ValidationError(`${input.provider} does not accept server-side events.`);
  }

  const willHaveToken = input.accessToken !== undefined
    ? Boolean(input.accessToken)
    : Boolean(input.hasExistingToken);

  // Google Ads carries its credential in the conversion fields rather than an
  // access token, and CUSTOM authenticates with a signature instead.
  const needsToken =
    input.serverSideEnabled && input.provider !== 'GOOGLE_ADS' && input.provider !== 'CUSTOM';

  if (needsToken && !willHaveToken) {
    throw new ValidationError(
      'Server-side tracking needs a Conversions API access token. Add one, or turn server-side off.',
    );
  }

  if (input.provider === 'CUSTOM' && !/^https:\/\//i.test(input.pixelId)) {
    throw new ValidationError('A custom pixel needs an https endpoint as its destination.');
  }
}

export async function createPixel(
  shopId: string,
  shopDomain: string,
  input: repository.UpsertPixelInput,
): Promise<PixelSummary> {
  assertCoherent({ ...input, hasExistingToken: false });

  // Plan gates run before anything is written, so a refused creation leaves no
  // half-configured pixel behind. Both are configuration-time refusals — the
  // merchant is looking at an upgrade button when they happen.
  await assertCanCreate(shopId, 'pixels');

  if (input.serverSideEnabled) {
    await assertFeature(shopId, 'serverSideTracking');
  }

  const pixel = await repository.createPixel(shopId, input);
  await invalidateTag(shopTag(shopDomain));

  log.info({ shopId, provider: pixel.provider }, 'Pixel created');
  return toSummary(pixel);
}

export async function updatePixel(
  shopId: string,
  shopDomain: string,
  id: string,
  input: Partial<repository.UpsertPixelInput>,
): Promise<PixelSummary> {
  const existing = await repository.findPixel(shopId, id);
  if (!existing) throw new NotFoundError('Pixel not found');

  assertCoherent({
    provider: input.provider ?? existing.provider,
    serverSideEnabled: input.serverSideEnabled ?? existing.serverSideEnabled,
    accessToken: input.accessToken,
    hasExistingToken: Boolean(existing.accessTokenEnc),
    pixelId: input.pixelId ?? existing.pixelId,
  });

  const updated = await repository.updatePixel(shopId, id, input);
  if (!updated) throw new NotFoundError('Pixel not found');

  await invalidateTag(shopTag(shopDomain));
  return toSummary(updated);
}

export async function deletePixel(shopId: string, shopDomain: string, id: string): Promise<void> {
  const removed = await repository.deletePixel(shopId, id);
  if (!removed) throw new NotFoundError('Pixel not found');

  await invalidateTag(shopTag(shopDomain));
}

/**
 * The pixels the storefront should load.
 *
 * Every field here is published to anonymous shoppers, so the shape is the
 * security boundary: there is no access token, no test event code and no
 * counters. A pixel id is public by design — it appears in the browser's
 * network tab on every site that uses one.
 */
export async function storefrontPixels(shopId: string): Promise<StorefrontPixel[]> {
  const pixels = await repository.listClientSidePixels(shopId);

  return pixels.map((pixel) => ({
    provider: pixel.provider,
    pixelId: pixel.pixelId,
    enabledEvents: pixel.enabledEvents,
    advancedMatching: pixel.advancedMatching,
    requireConsent: pixel.requireConsent,
    customScript: pixel.provider === 'CUSTOM' ? pixel.customScript : null,
    gtmContainerId: pixel.gtmContainerId,
    conversionId: pixel.conversionId,
    conversionLabel: pixel.conversionLabel,
  }));
}

export async function recentEvents(shopId: string, limit: number): Promise<PixelEventSummary[]> {
  const events = await repository.listRecentEvents(shopId, limit);

  return events.map((event) => ({
    id: event.id,
    pixelId: event.pixelId,
    provider: event.pixel?.provider ?? null,
    eventName: event.eventName,
    customEventName: event.customEventName,
    eventId: event.eventId,
    status: event.status,
    source: event.source as PixelEventSummary['source'],
    responseCode: event.responseCode,
    errorMessage: event.errorMessage,
    value: event.value?.toString() ?? null,
    currency: event.currency,
    createdAt: event.createdAt.toISOString(),
  }));
}

/**
 * Sends a synthetic event, for the event tester.
 *
 * Uses obviously-fake personal details so a merchant testing their setup does
 * not push a real shopper's hashed identifiers into their ad account — and so
 * the resulting event in Events Manager is recognisable as a test.
 *
 * The result is logged like any other dispatch, so a failed test appears in the
 * activity list with the provider's own error message rather than only in a
 * toast the merchant may have dismissed.
 */
export async function sendTestEvent(
  shopId: string,
  id: string,
  eventName: PixelEventName,
): Promise<PixelTestResult> {
  const pixel = await repository.findPixel(shopId, id);
  if (!pixel) throw new NotFoundError('Pixel not found');

  const provider = providerFor(pixel.provider);

  if (!provider) {
    throw new ValidationError(`${pixel.provider} has no server-side integration.`);
  }

  if (!provider.supports(eventName)) {
    throw new ValidationError(`${pixel.provider} has no equivalent for ${eventName}.`);
  }

  const shop = await repository.findShopContext(shopId);
  const eventId = `codflow-test-${Date.now()}`;

  const payload: PixelEventPayload = {
    eventName,
    customEventName: null,
    eventId,
    eventTime: Math.floor(Date.now() / 1_000),
    sourceUrl: shop ? `https://${shop.domain}` : null,
    value: 100,
    currency: shop?.currencyCode ?? 'USD',
    orderReference: 'CF-TESTTEST',
    contents: [{ id: 'codflow-test-product', quantity: 1, price: 100, title: 'CODkar test product' }],
    matching: buildMatching({
      email: 'codflow-test@example.com',
      phone: '+10000000000',
      firstName: 'Test',
      lastName: 'Order',
      city: 'Testville',
      state: 'ts',
      zip: '00000',
      country: 'us',
    }),
    clientIpAddress: null,
    clientUserAgent: 'CODkar-EventTester/1.0',
    fbp: null,
    fbc: null,
    ttclid: null,
    gclid: null,
    externalId: eventId,
  };

  const result = await provider.send(
    {
      pixelId: pixel.pixelId,
      accessToken: repository.decryptAccessToken(pixel),
      testEventCode: pixel.testEventCode,
      conversionId: pixel.conversionId,
      conversionLabel: pixel.conversionLabel,
      advancedMatching: pixel.advancedMatching,
      endpoint: pixel.provider === 'CUSTOM' ? pixel.pixelId : null,
    },
    payload,
  );

  await repository.logEvent({
    shopId,
    pixelId: pixel.id,
    codOrderId: null,
    eventName,
    customEventName: null,
    eventId,
    status: result.ok ? PixelDispatchStatus.SENT : PixelDispatchStatus.FAILED,
    source: 'server',
    responseCode: result.httpStatus,
    responseBody: result.responseBody,
    errorMessage: result.ok ? null : result.message,
  });

  return {
    provider: pixel.provider,
    ok: result.ok,
    httpStatus: result.httpStatus,
    message: result.message,
    eventId,
    matchQuality: result.matchQuality,
    sentAt: new Date().toISOString(),
  };
}

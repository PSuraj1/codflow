import {
  PixelDispatchStatus,
  Prisma,
  type CodOrder,
  type Pixel,
  type PixelEventName,
} from '@prisma/client';
import { prisma } from '../../db/prisma';
import { decrypt, encrypt } from '../../lib/crypto';

/**
 * Pixel persistence.
 *
 * Access tokens are AES-256-GCM encrypted here and decrypted only at the point
 * of dispatch. A Conversions API token grants write access to a merchant's ad
 * account — anyone holding one can inject conversions and distort their bidding
 * — so a database dump alone must not be enough to use it.
 */

export function listPixels(shopId: string): Promise<Pixel[]> {
  return prisma.pixel.findMany({ where: { shopId }, orderBy: { createdAt: 'asc' } });
}

/** Pixels eligible to receive a server-side event. */
export function listServerSidePixels(shopId: string): Promise<Pixel[]> {
  return prisma.pixel.findMany({
    where: { shopId, isEnabled: true, serverSideEnabled: true },
  });
}

/** Pixels the storefront should load. Tokens are never included. */
export function listClientSidePixels(shopId: string): Promise<Pixel[]> {
  return prisma.pixel.findMany({
    where: { shopId, isEnabled: true, clientSideEnabled: true },
  });
}

export function findPixel(shopId: string, id: string): Promise<Pixel | null> {
  return prisma.pixel.findFirst({ where: { id, shopId } });
}

/** Decrypts a pixel's access token. Never returned to a client. */
export function decryptAccessToken(pixel: Pixel): string | null {
  if (!pixel.accessTokenEnc) return null;

  try {
    return decrypt(pixel.accessTokenEnc);
  } catch {
    // A token encrypted under a rotated key. Reported as absent so the
    // dispatcher fails with "no token configured" rather than crashing.
    return null;
  }
}

export interface UpsertPixelInput {
  provider: Pixel['provider'];
  label: string;
  pixelId: string;
  isEnabled: boolean;
  clientSideEnabled: boolean;
  serverSideEnabled: boolean;
  /** Undefined leaves the stored token untouched; null clears it. */
  accessToken?: string | null;
  testEventCode: string | null;
  conversionId: string | null;
  conversionLabel: string | null;
  gtmContainerId: string | null;
  advancedMatching: boolean;
  deduplication: boolean;
  requireConsent: boolean;
  enabledEvents: PixelEventName[];
  customScript: string | null;
}

function tokenColumn(accessToken: string | null | undefined) {
  // Undefined means "not supplied" — the admin never sends the existing token
  // back, so an update must not clear it just because the field was absent.
  if (accessToken === undefined) return {};
  return { accessTokenEnc: accessToken === null ? null : encrypt(accessToken) };
}

export function createPixel(shopId: string, input: UpsertPixelInput): Promise<Pixel> {
  const { accessToken, ...rest } = input;

  return prisma.pixel.create({
    data: { shopId, ...rest, ...tokenColumn(accessToken) },
  });
}

export async function updatePixel(
  shopId: string,
  id: string,
  input: Partial<UpsertPixelInput>,
): Promise<Pixel | null> {
  const { accessToken, ...rest } = input;

  const result = await prisma.pixel.updateMany({
    where: { id, shopId },
    data: { ...rest, ...tokenColumn(accessToken) },
  });

  if (result.count === 0) return null;
  return findPixel(shopId, id);
}

export async function deletePixel(shopId: string, id: string): Promise<boolean> {
  const result = await prisma.pixel.deleteMany({ where: { id, shopId } });
  return result.count > 0;
}

export function recordDispatchOutcome(
  id: string,
  ok: boolean,
  errorMessage: string | null,
): Promise<{ id: string }> {
  return prisma.pixel.update({
    where: { id },
    data: ok
      ? { totalSent: { increment: 1 }, lastEventAt: new Date(), lastError: null }
      : { totalFailed: { increment: 1 }, lastError: errorMessage?.slice(0, 500) ?? null },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface LogEventInput {
  shopId: string;
  pixelId: string | null;
  codOrderId: string | null;
  eventName: PixelEventName;
  customEventName: string | null;
  eventId: string;
  status: PixelDispatchStatus;
  source: string;
  payload?: Prisma.InputJsonValue;
  responseCode?: number | null;
  responseBody?: string | null;
  errorMessage?: string | null;
  attempt?: number;
  value?: Prisma.Decimal | number | null;
  currency?: string | null;
}

export function logEvent(input: LogEventInput): Promise<{ id: string }> {
  return prisma.pixelEvent.create({
    data: {
      shopId: input.shopId,
      pixelId: input.pixelId,
      codOrderId: input.codOrderId,
      eventName: input.eventName,
      customEventName: input.customEventName,
      eventId: input.eventId,
      status: input.status,
      source: input.source,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      responseCode: input.responseCode ?? null,
      responseBody: input.responseBody?.slice(0, 2_000) ?? null,
      errorMessage: input.errorMessage?.slice(0, 1_000) ?? null,
      attempt: input.attempt ?? 1,
      value: input.value ?? null,
      currency: input.currency ?? null,
    },
    select: { id: true },
  });
}

/**
 * Whether this pixel already received this event.
 *
 * The last line of defence against double-counting. The queue deduplicates by
 * job id and the provider deduplicates by `event_id`, but a merchant clicking
 * "resend" or a replay after a schema change can still reach here — and a
 * duplicate Purchase is worse than a missing one, because it teaches the ad
 * platform to bid on a conversion that never happened.
 */
export async function alreadyDispatched(pixelId: string, eventId: string): Promise<boolean> {
  const existing = await prisma.pixelEvent.findFirst({
    where: { pixelId, eventId, status: PixelDispatchStatus.SENT },
    select: { id: true },
  });

  return existing !== null;
}

export function listRecentEvents(shopId: string, limit: number) {
  return prisma.pixelEvent.findMany({
    where: { shopId },
    include: { pixel: { select: { provider: true, label: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function findOrder(codOrderId: string): Promise<CodOrder | null> {
  return prisma.codOrder.findUnique({ where: { id: codOrderId } });
}

export function findShopContext(shopId: string) {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: { domain: true, currencyCode: true },
  });
}

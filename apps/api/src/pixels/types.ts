import type { PixelEventName, PixelProvider } from '@codflow/shared';
import type { HashedMatching } from './matching';

/**
 * The provider contract.
 *
 * Every ad platform wants the same conversion described differently — different
 * endpoint, different field names, different envelope, different idea of what a
 * "purchase" is called. This interface is where those differences stop: the
 * dispatcher builds one neutral event and each provider translates it.
 */

/** A conversion, before any provider has seen it. */
export interface PixelEventPayload {
  readonly eventName: PixelEventName;
  /** Only for CUSTOM events, where the merchant supplies the name. */
  readonly customEventName: string | null;

  /**
   * Shared between the browser and the server for the same action.
   *
   * This is what lets a provider discard the duplicate. Without it every COD
   * order that fired a client-side event *and* a server-side one counts twice,
   * which silently corrupts the merchant's ad bidding — the campaign appears
   * twice as efficient as it is and the budget follows.
   */
  readonly eventId: string;

  /** Unix seconds. Providers reject events older than roughly seven days. */
  readonly eventTime: number;
  readonly sourceUrl: string | null;

  readonly value: number | null;
  readonly currency: string | null;
  readonly orderReference: string;

  readonly contents: ReadonlyArray<{
    readonly id: string;
    readonly quantity: number;
    readonly price: number;
    readonly title: string;
  }>;

  readonly matching: HashedMatching;

  /** Browser identifiers, forwarded so the provider can join to its own cookie. */
  readonly clientIpAddress: string | null;
  readonly clientUserAgent: string | null;
  readonly fbp: string | null;
  readonly fbc: string | null;
  readonly ttclid: string | null;
  readonly gclid: string | null;
  readonly externalId: string | null;
}

/** Credentials and options for one configured pixel. */
export interface ProviderConfig {
  readonly pixelId: string;
  readonly accessToken: string | null;
  readonly testEventCode: string | null;
  readonly conversionId: string | null;
  readonly conversionLabel: string | null;
  readonly advancedMatching: boolean;
  /** Only for CUSTOM: the endpoint the merchant nominated. */
  readonly endpoint: string | null;
}

export interface DispatchResult {
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly message: string;
  /** Meta returns one; the others do not, and null is honest about that. */
  readonly matchQuality: number | null;
  /** Whether another attempt could plausibly succeed. */
  readonly retriable: boolean;
  readonly responseBody: string | null;
}

export interface Provider {
  readonly provider: PixelProvider;
  /** Whether this provider can accept the event at all. */
  supports(eventName: PixelEventName): boolean;
  send(config: ProviderConfig, payload: PixelEventPayload): Promise<DispatchResult>;
}

/** Bounds every provider call — an ad platform must never delay a queue worker. */
export const PROVIDER_TIMEOUT_MS = 8_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classifies an HTTP status.
 *
 * The distinction drives whether BullMQ retries. A 400 from an ad platform
 * means the payload is wrong and will be wrong forever; retrying it five times
 * just delays the failure and burns quota.
 */
export function classify(status: number): { ok: boolean; retriable: boolean } {
  if (status >= 200 && status < 300) return { ok: true, retriable: false };
  // 429 and 5xx clear on their own.
  if (status === 429 || status >= 500) return { ok: false, retriable: true };
  return { ok: false, retriable: false };
}

/** Normalizes a thrown error into a retriable failure. */
export function networkFailure(error: unknown): DispatchResult {
  const message = error instanceof Error ? error.message : String(error);

  return {
    ok: false,
    httpStatus: null,
    message: `Could not reach the provider: ${message}`,
    matchQuality: null,
    // DNS, TLS and socket resets are all transient.
    retriable: true,
    responseBody: null,
  };
}

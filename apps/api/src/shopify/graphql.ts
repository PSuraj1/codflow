import {
  HttpResponseError,
  HttpThrottlingError,
  type Session,
} from '@shopify/shopify-api';
import { shopify } from './client';
import { deleteShopSessions } from './sessionStorage';
import { createLogger } from '../lib/logger';
import { ReauthRequiredError, ShopifyApiError, toError } from '../lib/errors';

const log = createLogger('shopify-graphql');

/**
 * Admin GraphQL access.
 *
 * Wraps `shopify.clients.Graphql` to add the three behaviours every call site
 * would otherwise reimplement:
 *
 *  1. **Throttle backoff.** Shopify's GraphQL API is metered by query cost, not
 *     request count. Under load it answers 429 with a `Retry-After`; honouring
 *     that value is dramatically better than a fixed delay, because the leaky
 *     bucket refills at a known rate and guessing wastes the window.
 *  2. **Revoked-token detection.** A 401 means the stored offline token is dead
 *     — the merchant uninstalled/reinstalled, or revoked access. Keeping the
 *     dead session would make every subsequent request fail the same way, so it
 *     is deleted here and the caller is told to re-authorize.
 *  3. **userErrors promotion.** Shopify returns mutation failures as HTTP 200
 *     with a populated `userErrors` array. Left unchecked those read as
 *     successes, and the app cheerfully reports an order created that does not
 *     exist.
 */

/** Shape shared by every Shopify mutation's error array. */
export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface GraphqlRequestOptions {
  variables?: Record<string, unknown>;
  /** Total attempts, including the first. Throttled and 5xx responses are retried. */
  maxAttempts?: number;
  /** Aborts the request; propagated to the underlying fetch. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
/** Fallback when a 429 arrives without a usable Retry-After header. */
const DEFAULT_THROTTLE_DELAY_MS = 1_000;
const MAX_THROTTLE_DELAY_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  // 5xx is transient; 4xx other than 429 will fail identically on retry.
  return status >= 500 && status < 600;
}

/**
 * Executes an Admin GraphQL operation against a shop's offline session.
 *
 * Returns `data` directly — callers that need extensions or headers should use
 * the client from `shopify.clients.Graphql` themselves, which is rare enough
 * not to justify widening this signature.
 */
export async function adminGraphql<T>(
  session: Session,
  operation: string,
  options: GraphqlRequestOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const client = new shopify.clients.Graphql({ session });

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await client.request<T>(operation, {
        ...(options.variables ? { variables: options.variables } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        // Retries are handled here rather than by the client so throttle delays
        // can follow Retry-After instead of the client's fixed backoff.
        retries: 0,
      });

      if (!response.data) {
        throw new ShopifyApiError('Shopify returned a GraphQL response with no data', {
          details: { shop: session.shop },
        });
      }

      return response.data;
    } catch (error) {
      lastError = error;

      if (error instanceof HttpThrottlingError) {
        const retryAfterSeconds = error.response.retryAfter;
        const delayMs = Math.min(
          retryAfterSeconds ? retryAfterSeconds * 1_000 : DEFAULT_THROTTLE_DELAY_MS * attempt,
          MAX_THROTTLE_DELAY_MS,
        );

        if (attempt < maxAttempts) {
          log.warn({ shop: session.shop, attempt, delayMs }, 'Shopify throttled, backing off');
          await sleep(delayMs);
          continue;
        }
      }

      if (error instanceof HttpResponseError) {
        const status = error.response.code;

        // 401 with a token Shopify itself issued means the grant is gone.
        // Retrying cannot help; the merchant has to re-authorize.
        if (status === 401) {
          log.warn({ shop: session.shop }, 'Offline token rejected, purging session');
          await deleteShopSessions(session.shop);
          throw new ReauthRequiredError(session.shop, 'access token was revoked');
        }

        if (isRetriableStatus(status) && attempt < maxAttempts) {
          const delayMs = Math.min(DEFAULT_THROTTLE_DELAY_MS * attempt, MAX_THROTTLE_DELAY_MS);
          log.warn({ shop: session.shop, status, attempt, delayMs }, 'Shopify 5xx, retrying');
          await sleep(delayMs);
          continue;
        }

        throw new ShopifyApiError(`Shopify Admin API returned ${status}`, {
          cause: error,
          details: { shop: session.shop, status },
        });
      }

      // Not an HTTP-shaped failure — a network reset, a DNS blip, or our own
      // ShopifyApiError from the empty-data guard. Only the first two are worth
      // retrying, and both surface as generic Errors, so retry once more.
      if (attempt < maxAttempts && !(error instanceof ShopifyApiError)) {
        await sleep(DEFAULT_THROTTLE_DELAY_MS * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new ShopifyApiError('Shopify Admin API request exhausted its retries', {
    cause: lastError,
    details: { shop: session.shop, attempts: maxAttempts },
  });
}

/**
 * Throws when a mutation reported `userErrors`.
 *
 * Shopify signals business-rule failures — a variant that is out of stock, a
 * tag that is too long — inside a 200 response. Every mutation call site must
 * run its result through this, or those failures become silent no-ops.
 */
export function assertNoUserErrors(
  userErrors: readonly ShopifyUserError[] | null | undefined,
  operation: string,
): void {
  if (!userErrors || userErrors.length === 0) return;

  const summary = userErrors
    .map((entry) => {
      const field = entry.field?.join('.') ?? null;
      return field ? `${field}: ${entry.message}` : entry.message;
    })
    .join('; ');

  throw new ShopifyApiError(`${operation} failed: ${summary}`, {
    details: { operation, userErrors },
  });
}

/**
 * Runs an operation and swallows failure, returning null.
 *
 * For enrichment that must not block the caller — refreshing cached shop
 * metadata during login, for instance. A merchant should still get into the app
 * when Shopify is briefly unavailable.
 */
export async function tryAdminGraphql<T>(
  session: Session,
  operation: string,
  options: GraphqlRequestOptions = {},
): Promise<T | null> {
  try {
    return await adminGraphql<T>(session, operation, options);
  } catch (error) {
    // A revoked token is not "optional enrichment failed" — it invalidates the
    // session itself, so it must keep propagating.
    if (error instanceof ReauthRequiredError) throw error;

    log.warn({ shop: session.shop, err: toError(error) }, 'Optional Shopify request failed');
    return null;
  }
}

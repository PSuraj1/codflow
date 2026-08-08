import { HttpResponseError, type Session } from '@shopify/shopify-api';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import { shopify } from './client';

const log = createLogger('token-refresh');

/**
 * Keeps a stored offline token usable.
 *
 * Shopify is replacing permanent offline tokens with expiring ones. The two
 * facts that shape this file:
 *
 *  - **A permanent token is refused outright.** It is not merely discouraged;
 *    Shopify rejects calls made with one, which surfaces as a blanket API
 *    failure on queries that touch no customer data at all. The remedy is
 *    `migrateToExpiringToken`, which swaps it for an expiring one *without any
 *    merchant interaction* — no reinstall, no consent screen.
 *  - **An expiring token lives about an hour.** Background work runs with no
 *    merchant present and therefore no session token to exchange, so it cannot
 *    re-authenticate. It refreshes instead, using the refresh token stored
 *    beside the access token.
 *
 * Both cases are handled here rather than at the call sites because every
 * consumer — the worker, webhooks, the storefront config, order push, billing —
 * reaches Shopify through `loadOfflineSession`. Putting it anywhere else means
 * the next caller added is the one that forgets.
 */

/**
 * How long before expiry a token is treated as already expired.
 *
 * Shopify recommends refreshing ahead of the deadline rather than waiting for a
 * 401, because a token that passes the check and then expires mid-flight fails
 * a job that had no reason to fail. Five minutes comfortably covers a slow
 * order push.
 */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * In-flight refreshes, keyed by shop.
 *
 * A burst of jobs for one shop would otherwise each launch their own refresh.
 * Shopify tolerates that — it returns the same response for up to an hour after
 * the original refresh — but the request storm is pointless, and collapsing it
 * keeps the log readable.
 *
 * This is per-process only. The web service and the worker run separately and
 * cannot see each other's map; that race is handled by re-reading storage
 * immediately before refreshing, so whichever process goes second uses the
 * token the first one just wrote.
 */
const inFlight = new Map<string, Promise<Session>>();

/** A token with no expiry is a deprecated permanent one. */
export function isPermanent(session: Session): boolean {
  return Boolean(session.accessToken) && !session.expires;
}

/** True once the token is within the safety margin of its expiry. */
function isNearExpiry(session: Session): boolean {
  return Boolean(session.expires) && session.isExpired(REFRESH_MARGIN_MS);
}

/**
 * Returns a session whose access token Shopify will accept.
 *
 * Never throws. A failure here means the caller proceeds with the token it
 * already had, which is exactly what it would have done before this existed —
 * the call may fail, but it fails the same way rather than a new way.
 */
export async function ensureUsableToken(
  session: Session,
  reload: () => Promise<Session | undefined>,
  store: (session: Session) => Promise<void>,
): Promise<Session> {
  if (!isPermanent(session) && !isNearExpiry(session)) return session;

  const existing = inFlight.get(session.shop);
  if (existing) return existing;

  const attempt = renew(session, reload, store).finally(() => {
    inFlight.delete(session.shop);
  });

  inFlight.set(session.shop, attempt);

  return attempt;
}

async function renew(
  session: Session,
  reload: () => Promise<Session | undefined>,
  store: (session: Session) => Promise<void>,
): Promise<Session> {
  // Re-read first. Between loading and getting here another process may have
  // renewed the token; using its result is both correct and one fewer call.
  const current = (await reload()) ?? session;

  if (!isPermanent(current) && !isNearExpiry(current)) return current;

  try {
    const renewed = isPermanent(current)
      ? await migrate(current)
      : await refresh(current);

    await store(renewed);

    return renewed;
  } catch (error) {
    if (error instanceof HttpResponseError) {
      const body = error.response.body as { error?: string } | undefined;

      log.error(
        { shop: current.shop, status: error.response.code, reason: body?.error },
        isPermanent(current)
          ? 'Could not migrate to an expiring token — Admin API calls will keep failing'
          : 'Could not refresh the offline token — the merchant may need to reopen the app',
      );
    } else {
      log.error({ err: toError(error), shop: current.shop }, 'Token renewal failed');
    }

    return current;
  }
}

/**
 * Refreshes a token Shopify has just rejected, ignoring the expiry check.
 *
 * The pre-flight margin in `ensureUsableToken` catches almost everything, but
 * not a job that was enqueued while the token was healthy and ran an hour
 * later, and not a clock that disagrees with Shopify's. Both arrive as a 401 on
 * a token that looked fine, and both are fixed by spending the refresh token.
 *
 * Returns null when there is nothing to try or the attempt failed — which the
 * caller should read as "this grant really is gone", not as a transient error.
 */
export async function forceRefresh(session: Session): Promise<Session | null> {
  if (!session.refreshToken) return null;

  try {
    return await refresh(session);
  } catch (error) {
    log.warn(
      { shop: session.shop, err: toError(error) },
      'Refresh after a rejected token failed — treating the grant as revoked',
    );

    return null;
  }
}

/**
 * Swaps a permanent token for an expiring one.
 *
 * One-way and one-time per shop: Shopify revokes the permanent token when this
 * succeeds, and getting another would require sending the merchant back through
 * installation. There is no guard against calling it twice because there is no
 * need for one — once it succeeds the stored session has an expiry, so
 * `isPermanent` is false and this is never reached again.
 */
async function migrate(session: Session): Promise<Session> {
  const { session: migrated } = await shopify.auth.migrateToExpiringToken({
    shop: session.shop,
    nonExpiringOfflineAccessToken: session.accessToken!,
  });

  // The migration response carries no scope, and the scope is what the auth
  // middleware compares against the declared set. Dropping it would make every
  // subsequent request believe the grant had narrowed and re-exchange forever.
  migrated.scope = session.scope;

  log.info(
    { shop: session.shop, expires: migrated.expires?.toISOString() },
    'Migrated to an expiring offline access token',
  );

  return migrated;
}

/** Trades the refresh token for a fresh access token. */
async function refresh(session: Session): Promise<Session> {
  if (!session.refreshToken) {
    throw new Error('Offline session has expired and carries no refresh token');
  }

  const { session: refreshed } = await shopify.auth.refreshToken({
    shop: session.shop,
    refreshToken: session.refreshToken,
  });

  refreshed.scope = session.scope;

  log.info(
    { shop: session.shop, expires: refreshed.expires?.toISOString() },
    'Refreshed the offline access token',
  );

  return refreshed;
}

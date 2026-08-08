import {
  AuthScopes,
  HttpResponseError,
  InvalidJwtError,
  RequestedTokenType,
  type JwtPayload,
  type Session,
} from '@shopify/shopify-api';
import type { ScopeState } from '@codflow/shared';
import { config } from '../../config/env';
import { shopify } from '../../shopify/client';
import { loadOfflineSession, sessionStorage } from '../../shopify/sessionStorage';
import { createLogger } from '../../lib/logger';
import { normalizeShopDomain } from '../../lib/shopDomain';
import { ReauthRequiredError, SessionTokenError, ShopifyApiError, toError } from '../../lib/errors';

const log = createLogger('auth-service');

/**
 * Authentication for embedded admin traffic.
 *
 * CodFlow uses **managed installation with token exchange**, which is the only
 * flow Shopify supports for new embedded apps. The important consequence is
 * that this app never runs an authorization-code grant: it does not generate a
 * `state` nonce, does not host a redirect handler that swaps a code for a
 * token, and does not own an OAuth cookie. Shopify performs the grant, and the
 * app obtains an access token by exchanging the short-lived session token that
 * App Bridge already puts in every request.
 *
 * Practical differences that trip people up when porting from the legacy flow:
 *
 *  - There is no "install endpoint" to hit. The first authenticated request
 *    *is* the install, which is why `authenticateAdmin` provisions the shop.
 *  - Session tokens live about a minute. A token that was valid when the
 *    browser sent it can be expired on arrival, so rejection must be a
 *    retryable signal rather than a hard failure.
 *  - Offline tokens are the ones worth storing. Background work — Sheets sync,
 *    fraud rescans, webhook processing — happens with no merchant present and
 *    cannot depend on a session tied to one staff member's login.
 */

export interface ResolvedSession {
  readonly session: Session;
  readonly token: JwtPayload;
  readonly shopDomain: string;
  readonly userId: string | null;
  /** True when this request performed a token exchange rather than reusing storage. */
  readonly exchanged: boolean;
}

/** Scopes shopify.app.toml declares, as the library's comparison type. */
const requiredScopes = new AuthScopes(config.shopify.scopes);

/**
 * Verifies an App Bridge session token.
 *
 * Signature, expiry, not-before and audience are all checked by the library.
 * The audience check is the one that matters for isolation: without it, a valid
 * session token issued to a *different* app on the same shop would authenticate
 * here, because both are signed by Shopify.
 */
export async function verifySessionToken(token: string): Promise<JwtPayload> {
  try {
    return await shopify.session.decodeSessionToken(token);
  } catch (error) {
    if (error instanceof InvalidJwtError) {
      log.debug({ err: toError(error) }, 'Session token rejected');
      throw new SessionTokenError();
    }
    throw error;
  }
}

/**
 * Extracts the shop from a verified token.
 *
 * `dest` is the claim to trust — it is the shop the token was minted for. `iss`
 * points at the admin host and differs between the classic and unified admin
 * domains, so using it produces intermittent failures that depend on which
 * admin URL the merchant happens to be on.
 */
export function shopFromToken(payload: JwtPayload): string {
  const shop = normalizeShopDomain(payload.dest);

  if (!shop) {
    throw new SessionTokenError('Session token carries an invalid shop destination');
  }

  return shop;
}

/**
 * The staff user the token was issued for.
 *
 * `sub` is only meaningful on tokens minted for a logged-in user. It is used
 * for audit attribution only — never for authorization, because Shopify has
 * already decided this person may open the app, and second-guessing that would
 * mean maintaining a permission model the merchant never configured.
 */
export function userIdFromToken(payload: JwtPayload): string | null {
  return payload.sub && payload.sub.length > 0 ? payload.sub : null;
}

/** Compares granted scopes against what the app currently declares. */
export function evaluateScopes(granted: string | null | undefined): ScopeState {
  const grantedScopes = new AuthScopes(granted ?? '');
  const required = requiredScopes.toArray(true);
  const missing = required.filter((scope) => !grantedScopes.has(scope));

  return {
    granted: grantedScopes.toArray(true),
    required,
    missing,
    satisfied: missing.length === 0,
  };
}

/**
 * Exchanges a session token for an offline access token and stores it.
 *
 * Shopify's failure modes here are worth distinguishing, because they call for
 * opposite responses:
 *
 *  - `400 invalid_subject_token` — the session token is expired or was minted
 *    for another app. The client should fetch a fresh one and retry.
 *  - `400 invalid_grant` / `403` — the app is not installed on this shop, or
 *    the merchant revoked it. Retrying is useless; they must re-authorize.
 */
async function exchangeForOfflineToken(
  shopDomain: string,
  sessionToken: string,
): Promise<Session> {
  try {
    const { session } = await shopify.auth.tokenExchange({
      shop: shopDomain,
      sessionToken,
      requestedTokenType: RequestedTokenType.OfflineAccessToken,
      // Requests an *expiring* token. Omitting this sends `expiring: '0'` and
      // asks Shopify for a permanent one — which it no longer accepts on calls,
      // so the app installs cleanly and then fails every Admin API request.
      // The token that comes back lives about an hour and carries a refresh
      // token; `loadOfflineSession` keeps it current from there.
      expiring: true,
    });

    await sessionStorage.storeSession(session);

    log.info(
      { shop: shopDomain, scopes: session.scope, expires: session.expires?.toISOString() },
      'Offline access token obtained via token exchange',
    );

    return session;
  } catch (error) {
    if (error instanceof HttpResponseError) {
      const status = error.response.code;
      const body = error.response.body as { error?: string } | undefined;
      const reason = body?.error ?? String(status);

      if (reason === 'invalid_subject_token') {
        throw new SessionTokenError('Session token was rejected by Shopify');
      }

      if (status === 400 || status === 403) {
        throw new ReauthRequiredError(shopDomain, reason);
      }

      throw new ShopifyApiError(`Token exchange failed with ${status}`, {
        cause: error,
        details: { shop: shopDomain, status },
      });
    }

    throw error;
  }
}

/**
 * Produces a usable offline session for the shop behind a session token.
 *
 * Exchange is skipped when a stored session already covers the required scopes,
 * because it is a network round trip to Shopify on the critical path of every
 * admin request. It is forced in three cases:
 *
 *  - nothing stored (first authenticated request, i.e. the install)
 *  - stored session has no access token (a partially-written row)
 *  - stored scopes no longer cover what the app declares (scopes were widened
 *    and the merchant has since re-consented, so a fresh exchange returns the
 *    broader grant without any merchant-visible step)
 */
export async function resolveSession(bearerToken: string): Promise<ResolvedSession> {
  const token = await verifySessionToken(bearerToken);
  const shopDomain = shopFromToken(token);
  const userId = userIdFromToken(token);

  const stored = await loadOfflineSession(shopDomain);

  const needsExchange =
    !stored || !stored.accessToken || !new AuthScopes(stored.scope ?? '').has(requiredScopes);

  if (!needsExchange && stored) {
    return { session: stored, token, shopDomain, userId, exchanged: false };
  }

  if (stored && stored.accessToken) {
    log.info(
      { shop: shopDomain, stored: stored.scope, required: requiredScopes.toString() },
      'Stored scopes no longer cover the declared set, re-exchanging',
    );
  }

  const session = await exchangeForOfflineToken(shopDomain, bearerToken);

  return { session, token, shopDomain, userId, exchanged: true };
}

/**
 * Whether the offline session still satisfies the declared scopes.
 *
 * Called after `resolveSession`: if a fresh exchange still comes back short,
 * the merchant genuinely has not consented to the new scopes yet, and the only
 * remedy is sending them through managed installation again.
 */
export function sessionSatisfiesScopes(session: Session): boolean {
  return new AuthScopes(session.scope ?? '').has(requiredScopes);
}

/** The scope string the app currently declares, for persisting alongside a shop. */
export function declaredScopes(): string {
  return requiredScopes.toString();
}

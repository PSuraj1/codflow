import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';
import { InternalError, ServiceUnavailableError } from '../lib/errors';

const log = createLogger('google-client');

/**
 * Google OAuth.
 *
 * Separate from Shopify's auth in every respect: a different provider, a
 * different consent screen, and a refresh token that CODkar stores itself
 * rather than exchanging on demand. That last point is the one that shapes this
 * file — Google issues a refresh token **once**, on the first consent, and
 * never again unless you ask for it explicitly. Losing it means the merchant
 * has to disconnect and reconnect, so the request below is deliberate about
 * getting one and the repository encrypts it at rest.
 */

/**
 * Scopes requested at consent.
 *
 * `drive.file` rather than `drive` or `drive.readonly`, deliberately. It grants
 * access only to files this app created or that the merchant explicitly picked
 * through Google's own file picker — not their entire Drive. Broader Drive
 * scopes are "restricted" and drag the app into Google's annual third-party
 * security assessment, which is a real cost for a feature that only needs to
 * write to one spreadsheet.
 *
 * The trade is that listing arbitrary spreadsheets is not possible; the
 * merchant either creates a new sheet through the app or picks one, and from
 * then on that file is accessible.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const;

function assertConfigured(): void {
  if (!config.google.isConfigured) {
    // A merchant hitting this sees a clean 503 rather than a crash — Google
    // Sheets is an optional integration and the rest of the app works without
    // it, so an operator who has not set the credentials should not lose
    // everything else.
    throw new ServiceUnavailableError(
      'Google Sheets is not configured on this CODkar deployment.',
    );
  }
}

/** A bare client, for building the consent URL and exchanging the code. */
export function createOAuthClient(): OAuth2Client {
  assertConfigured();

  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
}

/**
 * Builds the consent URL.
 *
 * Three parameters matter, and omitting any of them produces a connection that
 * works today and breaks in a week:
 *
 *  - `access_type: 'offline'` — without it Google returns no refresh token, and
 *    the sync stops the moment the first access token expires an hour later.
 *  - `prompt: 'consent'` — Google only issues a refresh token on the *first*
 *    authorization. A merchant who previously connected and then reconnects
 *    gets no token back unless consent is forced. This is the single most
 *    common cause of "it worked, then it stopped".
 *  - `state` — carries the shop through the round trip and is verified on
 *    return. Without it the callback cannot tell which merchant it belongs to,
 *    and an attacker could attach their own Google account to someone's shop.
 */
export function buildConsentUrl(state: string): string {
  const client = createOAuthClient();

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...GOOGLE_SCOPES],
    include_granted_scopes: true,
    state,
  });
}

export interface GoogleTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
  readonly scopes: string[];
}

/** Exchanges the authorization code for tokens. */
export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new InternalError('Google returned no access token');
  }

  if (!tokens.refresh_token) {
    // Reachable when `prompt: 'consent'` was somehow omitted, or when the
    // merchant approved through a flow that reused a prior grant. Failing here
    // is right: storing an access-token-only connection produces a sync that
    // silently dies in an hour, which is far harder to diagnose than a refusal
    // at connect time.
    throw new InternalError(
      'Google did not return a refresh token. Remove CODkar from your Google account permissions and connect again.',
    );
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3_600_000),
    scopes: tokens.scope?.split(' ') ?? [...GOOGLE_SCOPES],
  };
}

/** The Google account behind a set of tokens, for display in the admin. */
export async function fetchUserInfo(accessToken: string): Promise<{
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new InternalError(`Could not read the Google account profile (${response.status})`);
  }

  const body = (await response.json()) as {
    id: string;
    email: string;
    name?: string;
    picture?: string;
  };

  return {
    id: body.id,
    email: body.email,
    name: body.name ?? null,
    picture: body.picture ?? null,
  };
}

/**
 * Refreshes an access token.
 *
 * `invalid_grant` is the response that matters and is reported distinctly: it
 * means the refresh token is dead — the merchant revoked access in their Google
 * account, changed their password, or the token went unused for six months.
 * Retrying cannot fix it, so the caller marks the connection revoked and the
 * admin prompts a reconnect rather than retrying forever.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date } | 'revoked'> {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });

  try {
    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new InternalError('Google refresh returned no access token');
    }

    return {
      accessToken: credentials.access_token,
      expiresAt: new Date(credentials.expiry_date ?? Date.now() + 3_600_000),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('invalid_grant') || message.includes('invalid_request')) {
      log.warn('Google refresh token is no longer valid');
      return 'revoked';
    }

    throw error;
  }
}

/** Best-effort revocation, so disconnecting in CODkar also revokes at Google. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch (error) {
    // The local record is deleted regardless. A merchant who disconnects should
    // not be blocked because Google was briefly unreachable — and they can
    // always revoke from their Google account settings.
    log.warn({ err: error }, 'Could not revoke the Google token remotely');
  }
}

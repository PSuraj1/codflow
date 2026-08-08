import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { GoogleAccountSummary } from '@codflow/shared';
import { config } from '../../config/env';
import { createLogger } from '../../lib/logger';
import { BadRequestError, ConflictError, NotFoundError, toError } from '../../lib/errors';
import {
  buildConsentUrl,
  exchangeCode,
  fetchUserInfo,
  refreshAccessToken,
  revokeToken,
} from '../../google/client';
import * as repository from './repository';

const log = createLogger('google-service');

/**
 * Google account connection lifecycle.
 *
 * The part worth reading closely is the OAuth `state`. Google's callback
 * arrives at a public endpoint with no session — the merchant's browser is
 * coming back from accounts.google.com, not from the embedded app — so the only
 * thing tying the response to a shop is what CODkar put in `state` on the way
 * out. If that were just the shop domain, anyone could complete the flow and
 * attach *their* Google account to *someone else's* shop, and every subsequent
 * COD order would be written into a spreadsheet they control.
 *
 * So state is signed and time-limited, exactly like the storefront form token.
 */

const STATE_VERSION = 'v1';
const STATE_TTL_SECONDS = 15 * 60;

interface StatePayload {
  readonly shop: string;
  readonly issuedAt: number;
  readonly nonce: string;
}

function signState(body: string): string {
  return createHmac('sha256', config.security.sessionSecret)
    .update(`google:${body}`)
    .digest('base64url');
}

function issueState(shopDomain: string): string {
  const payload: StatePayload = {
    shop: shopDomain,
    issuedAt: Math.floor(Date.now() / 1_000),
    nonce: randomBytes(9).toString('base64url'),
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${STATE_VERSION}.${body}.${signState(body)}`;
}

/** Verifies the state parameter and returns the shop it was issued for. */
export function verifyState(state: string): string {
  const parts = state.split('.');

  if (parts.length !== 3 || parts[0] !== STATE_VERSION) {
    throw new BadRequestError('This Google connection link is not valid.');
  }

  const [, body, signature] = parts as [string, string, string];
  const expected = signState(body);

  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    log.warn('Google OAuth state failed signature verification');
    throw new BadRequestError('This Google connection link is not valid.');
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new BadRequestError('This Google connection link is not valid.');
  }

  if (Math.floor(Date.now() / 1_000) - payload.issuedAt > STATE_TTL_SECONDS) {
    throw new BadRequestError('This Google connection link has expired. Start again.');
  }

  return payload.shop;
}

/** Consent URL for a shop. The merchant's browser opens this in the top frame. */
export function startConnect(shopDomain: string): string {
  return buildConsentUrl(issueState(shopDomain));
}

/** Completes the callback: exchange, identify, store. */
export async function completeConnect(
  shopId: string,
  code: string,
): Promise<GoogleAccountSummary> {
  const tokens = await exchangeCode(code);
  const profile = await fetchUserInfo(tokens.accessToken);

  const account = await repository.upsertAccount({
    shopId,
    googleUserId: profile.id,
    email: profile.email,
    displayName: profile.name,
    avatarUrl: profile.picture,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
  });

  log.info({ shopId, email: profile.email }, 'Google account connected');

  return toSummary(account);
}

export async function getAccount(shopId: string): Promise<GoogleAccountSummary | null> {
  const account = await repository.findByShop(shopId);
  return account ? toSummary(account) : null;
}

export async function disconnect(shopId: string): Promise<void> {
  const account = await repository.findByShop(shopId);

  if (!account) throw new NotFoundError('No Google account is connected');

  // Revoked at Google first, so a merchant who disconnects genuinely loses the
  // grant rather than merely losing CODkar's copy of it. Best-effort: the
  // local record is removed either way.
  try {
    const tokens = repository.decryptTokens(account);
    await revokeToken(tokens.refreshToken);
  } catch (error) {
    log.warn({ err: toError(error), shopId }, 'Could not revoke at Google before disconnecting');
  }

  await repository.deleteAccount(shopId);
  log.info({ shopId }, 'Google account disconnected');
}

/**
 * A valid access token for a shop, refreshing when necessary.
 *
 * The single entry point every Sheets call goes through. Refreshing 60 seconds
 * early avoids the race where a token passes the expiry check and then expires
 * mid-request — which surfaces as an intermittent 401 that is very hard to
 * reproduce.
 */
export async function accessTokenFor(shopId: string): Promise<{
  accessToken: string;
  accountId: string;
}> {
  const account = await repository.findByShop(shopId);

  if (!account) {
    throw new NotFoundError('Connect a Google account before syncing to Sheets');
  }

  if (account.revokedAt) {
    throw new ConflictError(
      'Your Google connection was revoked. Reconnect your Google account to resume syncing.',
    );
  }

  const tokens = repository.decryptTokens(account);
  const expiresSoon = tokens.expiresAt.getTime() - Date.now() < 60_000;

  if (!expiresSoon) {
    return { accessToken: tokens.accessToken, accountId: account.id };
  }

  const refreshed = await refreshAccessToken(tokens.refreshToken);

  if (refreshed === 'revoked') {
    await repository.markRevoked(
      account.id,
      'Google rejected the refresh token — access was revoked or expired.',
    );

    throw new ConflictError(
      'Your Google connection is no longer valid. Reconnect your Google account to resume syncing.',
    );
  }

  await repository.updateAccessToken(account.id, refreshed.accessToken, refreshed.expiresAt);

  return { accessToken: refreshed.accessToken, accountId: account.id };
}

function toSummary(account: {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  lastError: string | null;
}): GoogleAccountSummary {
  return {
    email: account.email,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    connectedAt: account.createdAt.toISOString(),
    revokedAt: account.revokedAt?.toISOString() ?? null,
    lastError: account.lastError,
  };
}

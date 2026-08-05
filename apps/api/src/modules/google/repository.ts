import type { GoogleAccount } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { decrypt, encrypt } from '../../lib/crypto';

/**
 * Google account persistence.
 *
 * Both tokens are AES-256-GCM encrypted before they reach Postgres and
 * decrypted only at the point of use. The refresh token especially: it is a
 * long-lived credential to a merchant's Google Drive, and a database dump alone
 * must not be enough to use it.
 *
 * Encryption happens here rather than in the service so there is no path that
 * writes a token in the clear — a service that forgot to encrypt would still
 * type-check.
 */

export interface StoreAccountInput {
  shopId: string;
  googleUserId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  scopes: string[];
}

/**
 * Creates or replaces the shop's Google connection.
 *
 * One account per shop — `GoogleAccount.shopId` is unique — so reconnecting
 * overwrites rather than accumulating. `revokedAt` and `lastError` are cleared
 * on write, because a successful connection is exactly the event that resolves
 * a previous revocation.
 */
export async function upsertAccount(input: StoreAccountInput): Promise<GoogleAccount> {
  const data = {
    googleUserId: input.googleUserId,
    email: input.email,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    accessTokenEnc: encrypt(input.accessToken),
    refreshTokenEnc: encrypt(input.refreshToken),
    tokenExpiresAt: input.tokenExpiresAt,
    scopes: input.scopes,
    isActive: true,
    revokedAt: null,
    lastError: null,
    lastRefreshedAt: new Date(),
  };

  return prisma.googleAccount.upsert({
    where: { shopId: input.shopId },
    update: data,
    create: { shopId: input.shopId, ...data },
  });
}

export function findByShop(shopId: string): Promise<GoogleAccount | null> {
  return prisma.googleAccount.findUnique({ where: { shopId } });
}

/** Decrypted tokens. Never returned to a client — internal use only. */
export interface DecryptedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date;
}

export function decryptTokens(account: GoogleAccount): DecryptedTokens {
  return {
    accessToken: decrypt(account.accessTokenEnc),
    refreshToken: decrypt(account.refreshTokenEnc),
    expiresAt: account.tokenExpiresAt,
  };
}

/** Stores a refreshed access token. The refresh token itself is unchanged. */
export function updateAccessToken(
  id: string,
  accessToken: string,
  expiresAt: Date,
): Promise<GoogleAccount> {
  return prisma.googleAccount.update({
    where: { id },
    data: {
      accessTokenEnc: encrypt(accessToken),
      tokenExpiresAt: expiresAt,
      lastRefreshedAt: new Date(),
      lastError: null,
    },
  });
}

/**
 * Marks the connection dead.
 *
 * Called when Google answers `invalid_grant` — the merchant revoked access,
 * changed their password, or the token went unused for six months. The row is
 * kept rather than deleted so the admin can show *which* account needs
 * reconnecting, and so the sheet configuration attached to it survives.
 */
export function markRevoked(id: string, reason: string): Promise<GoogleAccount> {
  return prisma.googleAccount.update({
    where: { id },
    data: {
      isActive: false,
      revokedAt: new Date(),
      lastError: reason.slice(0, 500),
    },
  });
}

export function recordError(id: string, message: string): Promise<GoogleAccount> {
  return prisma.googleAccount.update({
    where: { id },
    data: { lastError: message.slice(0, 500) },
  });
}

/**
 * Removes the connection and everything hanging off it.
 *
 * `SheetConfig` cascades from `GoogleAccount`, so disconnecting also removes
 * the sheet mapping. That is intentional — a mapping pointing at a spreadsheet
 * the app can no longer reach is worse than no mapping, because it looks
 * configured while silently failing every sync.
 */
export async function deleteAccount(shopId: string): Promise<boolean> {
  const account = await prisma.googleAccount.findUnique({
    where: { shopId },
    select: { id: true },
  });

  if (!account) return false;

  await prisma.googleAccount.delete({ where: { id: account.id } });
  return true;
}

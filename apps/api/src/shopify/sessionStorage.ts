import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';
import type { Session } from '@shopify/shopify-api';
import { prisma } from '../db/prisma';
import { createLogger } from '../lib/logger';
import { shopify } from './client';

const log = createLogger('session-storage');

/**
 * Shopify session persistence, backed by the `Session` model.
 *
 * `tableName` names the PrismaClient property, not the SQL table — the model is
 * `Session`, so the accessor is `prisma.session`, even though it is mapped to
 * `shopify_sessions` in Postgres via `@@map`.
 *
 * The model's field names and types are dictated by this package. Renaming a
 * field or adding a required one breaks session storage at runtime rather than
 * at compile time, so the schema carries a warning to that effect.
 */
export const sessionStorage = new PrismaSessionStorage(prisma, {
  tableName: 'session',
});

/**
 * Loads the offline session for a shop.
 *
 * Offline sessions are the ones that matter for this app: background work
 * (webhook processing, Google Sheets sync, scheduled fraud rescans) runs with
 * no merchant present, so it cannot depend on an online session tied to a
 * particular staff member's login.
 *
 * Returns null when the shop has never installed, or when the session was
 * deleted on uninstall.
 */
export async function loadOfflineSession(shop: string): Promise<Session | undefined> {
  const sessionId = shopify.session.getOfflineId(shop);

  try {
    return await sessionStorage.loadSession(sessionId);
  } catch (error) {
    log.error({ err: error, shop }, 'Failed to load offline session');
    return undefined;
  }
}

/** Removes every stored session for a shop. Called on uninstall. */
export async function deleteShopSessions(shop: string): Promise<number> {
  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);

    if (sessions.length === 0) return 0;

    await sessionStorage.deleteSessions(sessions.map((session) => session.id));
    log.info({ shop, count: sessions.length }, 'Deleted shop sessions');

    return sessions.length;
  } catch (error) {
    log.error({ err: error, shop }, 'Failed to delete shop sessions');
    return 0;
  }
}

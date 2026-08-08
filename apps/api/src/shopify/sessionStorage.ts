import { PrismaSessionStorage } from '@shopify/shopify-app-session-storage-prisma';
import type { Session } from '@shopify/shopify-api';
import { prisma } from '../db/prisma';
import { createLogger } from '../lib/logger';
import { shopify } from './client';
import { ensureUsableToken, forceRefresh, isPermanent } from './tokenRefresh';

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
 * The token is renewed here rather than by the caller. Shopify refuses calls
 * made with the deprecated permanent tokens and expires the new ones after
 * roughly an hour, so "load a session" and "hold a token Shopify will accept"
 * have to be the same operation — every consumer reaches Shopify through this
 * function, and none of them is a sensible place to duplicate the rule. See
 * `tokenRefresh.ts`. Renewal never throws: a failure returns the stored session
 * unchanged, so a caller is never worse off than before.
 *
 * Returns null when the shop has never installed, or when the session was
 * deleted on uninstall.
 */
export async function loadOfflineSession(shop: string): Promise<Session | undefined> {
  const sessionId = shopify.session.getOfflineId(shop);

  try {
    const session = await sessionStorage.loadSession(sessionId);

    if (!session?.accessToken) return session;

    return await ensureUsableToken(
      session,
      () => sessionStorage.loadSession(sessionId),
      (renewed) => sessionStorage.storeSession(renewed).then(() => undefined),
    );
  } catch (error) {
    log.error({ err: error, shop }, 'Failed to load offline session');
    return undefined;
  }
}

/**
 * Last-chance renewal for a token Shopify rejected mid-request.
 *
 * Separate from `loadOfflineSession` because the trigger is different: that one
 * acts on a *predicted* expiry, this one on an observed 401. Returns null when
 * the grant is genuinely gone, which is the caller's signal to purge.
 */
export async function refreshRejectedSession(session: Session): Promise<Session | null> {
  const renewed = await forceRefresh(session);

  if (!renewed) return null;

  await sessionStorage.storeSession(renewed);

  return renewed;
}

/**
 * Migrates every shop still holding a deprecated permanent token.
 *
 * `loadOfflineSession` already migrates on demand, which covers any shop whose
 * merchant opens the app or whose queue wakes up. This exists for the one it
 * cannot reach: a shop that installed, never came back, and has no queued work
 * — its token stays permanent, and therefore refused, until something touches
 * it. For a COD app that shop is not idle in the way it looks, because the next
 * thing to touch it is a shopper submitting an order.
 *
 * Deliberately shaped like the retention sweep: bounded, continue-on-failure,
 * and never fatal to boot. A shop that cannot be migrated is logged and skipped
 * — it will be retried on the next boot, and on-demand migration is still in
 * front of every path that matters.
 *
 * Returns the number migrated, for the boot log.
 */
export async function migratePermanentTokens(limit = 500): Promise<number> {
  let migrated = 0;

  try {
    const rows = await prisma.session.findMany({
      where: { isOnline: false, expires: null },
      select: { shop: true },
      take: limit,
    });

    if (rows.length === 0) return 0;

    log.info({ count: rows.length }, 'Shops holding a permanent offline token');

    for (const { shop } of rows) {
      // Going through loadOfflineSession rather than calling the migration
      // directly keeps one implementation of "make this token usable" — the
      // one that is already covered by tests.
      const session = await loadOfflineSession(shop);

      if (session && !isPermanent(session)) migrated += 1;
    }
  } catch (error) {
    log.error({ err: error }, 'Permanent-token sweep failed');
  }

  return migrated;
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

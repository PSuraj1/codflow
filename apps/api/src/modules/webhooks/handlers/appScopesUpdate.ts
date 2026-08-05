import { createLogger } from '../../../lib/logger';
import { loadOfflineSession, sessionStorage } from '../../../shopify/sessionStorage';
import * as shopRepository from '../../shop/repository';
import * as authService from '../../auth/service';
import * as audit from '../../audit/service';
import type { WebhookHandler } from './types';

const log = createLogger('webhook:app/scopes_update');

/**
 * `app/scopes_update` — the merchant's granted scopes changed.
 *
 * Fires when scopes are widened (a deploy added one and the merchant
 * consented) or narrowed (they revoked an optional scope). The payload carries
 * the authoritative list:
 *
 *   { "current": ["read_orders", "write_orders", ...], "previous": [...] }
 *
 * Both the stored session and the `Shop` row have to be updated, because they
 * are read by different code paths. The session's `scope` is what the auth
 * middleware compares against on the next request; the shop's `grantedScopes`
 * is what the admin renders in its permissions banner. Updating only one
 * produces an app that either nags for consent already given, or claims a
 * permission it no longer has.
 *
 * Handled inline rather than queued: if a merchant re-consents and immediately
 * returns to the app, a queued update would not have landed yet and they would
 * be sent straight back to the consent screen.
 */
export const appScopesUpdate: WebhookHandler = async (context) => {
  const current = context.payload.current;
  const scopes = Array.isArray(current) ? current.filter((s): s is string => typeof s === 'string') : [];

  if (scopes.length === 0) {
    log.warn({ shop: context.shopDomain }, 'scopes_update carried no current scopes — ignoring');
    return;
  }

  const scopeString = scopes.join(',');

  // The session is the copy the auth middleware trusts, so it goes first.
  const session = await loadOfflineSession(context.shopDomain);
  if (session) {
    session.scope = scopeString;
    await sessionStorage.storeSession(session);
  }

  if (context.shopId) {
    const previous = Array.isArray(context.payload.previous)
      ? (context.payload.previous as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    await shopRepository.updateGrantedScopes(context.shopId, scopeString);

    await audit.record({
      shopId: context.shopId,
      action: audit.AuditAction.SCOPES_UPDATED,
      entity: 'Shop',
      entityId: context.shopId,
      actor: audit.AuditActor.SHOPIFY,
      before: { scopes: previous },
      after: { scopes },
    });
  }

  const state = authService.evaluateScopes(scopeString);

  if (!state.satisfied) {
    // Narrowed below what the app needs. Not an error to fix here — the auth
    // middleware will prompt for consent on the next request — but worth a
    // warning, because features will start failing for this merchant.
    log.warn(
      { shop: context.shopDomain, missing: state.missing },
      'Granted scopes now fall short of the declared set',
    );
    return;
  }

  log.info({ shop: context.shopDomain, scopes: scopeString }, 'Granted scopes updated');
};

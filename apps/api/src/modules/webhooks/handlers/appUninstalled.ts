import { createLogger } from '../../../lib/logger';
import { invalidateTag, shopTag } from '../../../lib/cache';
import { deleteShopSessions } from '../../../shopify/sessionStorage';
import * as shopRepository from '../../shop/repository';
import * as audit from '../../audit/service';
import type { WebhookHandler } from './types';

const log = createLogger('webhook:app/uninstalled');

/**
 * `app/uninstalled` — the merchant removed the app.
 *
 * Two things must happen, and the order is not arbitrary:
 *
 *  1. **Delete the sessions.** The offline access token is dead the moment the
 *     app is uninstalled. Leaving it in storage means every queued job for this
 *     shop wakes up, calls Shopify, gets a 401, and retries — turning one
 *     uninstall into a slow flood of doomed requests.
 *  2. **Mark the shop inactive, but keep its data.** Shopify only requires
 *     erasure on `shop/redact`, which arrives 48 hours later. Until then the
 *     merchant's forms, blacklist and order history stay, so an uninstall
 *     followed by a same-day reinstall — a normal thing to do while evaluating
 *     apps — restores everything instead of presenting an empty app.
 *
 * Handled inline rather than queued: a queued job would need the very session
 * this handler deletes.
 */
export const appUninstalled: WebhookHandler = async (context) => {
  await deleteShopSessions(context.shopDomain);

  // The storefront config is cached for five minutes and served from shared
  // caches for longer. Without this, COD buttons keep rendering on a store that
  // no longer has the app — and every click leads to an order the merchant
  // cannot see.
  await invalidateTag(shopTag(context.shopDomain));

  const shopId = await shopRepository.markUninstalled(context.shopDomain);

  if (!shopId) {
    // Shopify sends this for shops that never completed an install, and retries
    // it after a `shop/redact` has already removed the row.
    log.info({ shop: context.shopDomain }, 'Uninstall for a shop with no record — nothing to do');
    return;
  }

  await audit.record({
    shopId,
    action: audit.AuditAction.APP_UNINSTALLED,
    entity: 'Shop',
    entityId: shopId,
    actor: audit.AuditActor.SHOPIFY,
    after: { isActive: false, uninstalledAt: new Date().toISOString() },
  });

  log.info({ shop: context.shopDomain }, 'App uninstalled — data retained pending shop/redact');
};

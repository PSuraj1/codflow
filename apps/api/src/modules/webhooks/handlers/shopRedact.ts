import { createLogger } from '../../../lib/logger';
import { invalidateTag, shopTag } from '../../../lib/cache';
import { deleteShopSessions } from '../../../shopify/sessionStorage';
import * as shopRepository from '../../shop/repository';
import * as audit from '../../audit/service';
import type { WebhookHandler } from './types';

const log = createLogger('webhook:shop/redact');

/**
 * `shop/redact` — erase everything for this shop.
 *
 * Shopify sends this 48 hours after uninstall and requires the app to delete
 * the shop's data. This is the point where retention ends; up to here the data
 * was kept so a reinstall would restore the merchant's configuration.
 *
 * The deletion is a single statement. Every model hangs off `Shop` with
 * `onDelete: Cascade`, so removing the root row removes orders, risk
 * assessments, OTP records, sync logs and audit rows with it. That cascade is
 * the reason the schema insists on `shopId` on every table — a model that
 * forgot it would survive this delete and quietly retain merchant data past the
 * point the app promised to remove it.
 *
 * The audit row is written *before* the delete, and against a null shop, so it
 * outlives the cascade. Keeping a record that erasure happened is not a
 * retention of personal data — it names no customer — and it is the only
 * evidence available if the merchant later asks whether the request was
 * honoured.
 */
export const shopRedact: WebhookHandler = async (context) => {
  await audit.record({
    // Deliberately null: attaching this to the shop would cascade it away with
    // everything else, destroying the proof that the deletion ran.
    shopId: null,
    action: audit.AuditAction.SHOP_REDACTED,
    entity: 'Shop',
    entityId: context.shopId,
    actor: audit.AuditActor.SHOPIFY,
    after: { shopDomain: context.shopDomain, webhookId: context.webhookId },
  });

  await deleteShopSessions(context.shopDomain);

  // Cached storefront config is derived personal-adjacent merchant data and
  // must go with the rest of it, not linger until its TTL.
  await invalidateTag(shopTag(context.shopDomain));

  const purged = await shopRepository.purge(context.shopDomain);

  if (!purged) {
    // Already gone, or never installed. Both are success — the obligation is
    // that no data remains, not that a row was deleted.
    log.info({ shop: context.shopDomain }, 'shop/redact for a shop with no data');
    return;
  }

  log.warn({ shop: context.shopDomain }, 'Shop data erased in response to shop/redact');
};

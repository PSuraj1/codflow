import { createLogger } from '../../../lib/logger';
import * as audit from '../../audit/service';
import * as billingRepository from '../../billing/repository';
import * as billingService from '../../billing/service';
import type { WebhookHandler } from './types';

const log = createLogger('webhook:app_subscriptions/update');

/**
 * `app_subscriptions/update` — the merchant's plan changed.
 *
 * The only path by which this app learns about a **cancellation or a freeze**
 * promptly. An upgrade announces itself: the merchant is standing in the app
 * waiting for their new features, and the refresh endpoint covers them. A
 * cancellation is silent — nobody comes back to tell us — so without this
 * webhook a cancelled shop would keep paid features until the lazy check
 * happened to run, which is exactly the failure direction that costs money.
 *
 * The payload carries the new status, but it is deliberately **not trusted as
 * the whole answer**. It describes one subscription; the shop's entitlement is
 * a function of every active subscription it has, and a downgrade arrives as a
 * cancellation of the old plan and a creation of the new one in an order this
 * handler cannot depend on. So the payload is used as a *trigger* and the
 * authoritative state is re-read from Shopify — one query, on an event that
 * fires a handful of times in a shop's lifetime.
 */
export const appSubscriptionsUpdate: WebhookHandler = async (context) => {
  if (!context.shopId) {
    // A subscription event for a shop with no row. Possible if the merchant
    // subscribed during an install that never finished provisioning.
    log.warn({ shop: context.shopDomain }, 'Subscription update for an unknown shop');
    return;
  }

  const payload = context.payload.app_subscription as Record<string, unknown> | undefined;
  const reportedStatus = typeof payload?.status === 'string' ? payload.status : null;
  const reportedName = typeof payload?.name === 'string' ? payload.name : null;

  const before = await billingRepository.findByShop(context.shopId);
  const after = await billingService.reconcile(context.shopId, context.shopDomain);

  if (!after) {
    // Reconciliation failed — the plan is unchanged and still stale. Logged at
    // error because a missed cancellation is revenue leaking silently, and the
    // stored `lastVerifiedAt` is what a later sweep will use to catch it.
    log.error(
      { shop: context.shopDomain, reportedStatus, reportedName },
      'Subscription changed but could not be verified — the cached plan is now stale',
    );
    return;
  }

  const changed = before?.plan !== after.plan || before?.status !== after.status;

  if (changed) {
    await audit.record({
      shopId: context.shopId,
      action: 'billing.subscription_changed',
      entity: 'Subscription',
      entityId: after.id,
      actor: audit.AuditActor.SHOPIFY,
      before: before ? { plan: before.plan, status: before.status } : null,
      after: { plan: after.plan, status: after.status },
    });
  }

  log.info(
    {
      shop: context.shopDomain,
      from: before ? `${before.plan}/${before.status}` : 'none',
      to: `${after.plan}/${after.status}`,
      reportedStatus,
    },
    changed ? 'Subscription changed' : 'Subscription re-verified, unchanged',
  );
};

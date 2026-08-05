import type { NextFunction, Request, Response } from 'express';
import { CodOrderStatus, RiskAction } from '@prisma/client';
import type { OrderPushStatus, StuckOrdersPage } from '@codflow/shared';
import { accepted, ok } from '../../lib/http';
import { ConflictError, InternalError, NotFoundError } from '../../lib/errors';
import { enqueueOrderPush } from '../../queue/queues';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as repository from './repository';
import { GateDecision, evaluateGates } from './gates';
import type { StuckQueryInput } from './adminRoutes';

/**
 * Merchant-facing order operations.
 *
 * Only the push-recovery surface for now — the full order management screens
 * are a later phase. This exists because a failed push is the one order state a
 * merchant cannot resolve on their own: the order is in CodFlow, the customer
 * is expecting delivery, and without a retry the merchant would have to rekey
 * it into Shopify by hand.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/**
 * `GET /api/admin/orders/:reference/push-status`
 *
 * Why an order has not reached Shopify, in the merchant's terms. Answers the
 * three questions they actually have: is it stuck, why, and can I do anything.
 */
export async function pushStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const reference = req.params.reference as string;

    const order = await repository.findByReference(auth.shopId, reference);
    if (!order) throw new NotFoundError('Order not found');

    const gate = evaluateGates(order);

    const payload: OrderPushStatus = {
      reference: order.reference,
      status: order.status,
      shopifyOrderNumber: order.shopifyOrderNumber,
      shopifyOrderGid: order.shopifyOrderGid,
      draftOrderGid: order.shopifyDraftOrderGid,
      pushedAt: order.pushedAt?.toISOString() ?? null,
      pushAttempts: order.pushAttempts,
      pushError: order.pushError,
      gate: {
        decision: gate.decision,
        code: gate.code,
        reason: gate.reason,
      },
      // A blocked order can never be retried; a held one becomes retryable once
      // the hold clears. Telling the client which lets the UI show a disabled
      // button with an explanation rather than one that always fails.
      retryable: gate.decision === GateDecision.ALLOW,
    };

    ok(res, payload);
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /api/admin/orders/:reference/retry-push`
 *
 * Re-queues an order that failed to reach Shopify.
 *
 * The status is reset to CONFIRMED first. Without that the gates would see a
 * FAILED order — and more importantly the merchant's dashboard would keep
 * showing a failure for an order that is now in flight again.
 */
export async function retryPush(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const reference = req.params.reference as string;

    const order = await repository.findByReference(auth.shopId, reference);
    if (!order) throw new NotFoundError('Order not found');

    if (order.shopifyOrderGid) {
      // Re-pushing would create a second Shopify order for one customer, which
      // the merchant discovers by shipping both.
      throw new ConflictError(
        `This order is already in Shopify as ${order.shopifyOrderNumber ?? 'an order'}.`,
      );
    }

    const gate = evaluateGates(order);

    if (gate.decision === GateDecision.BLOCK) {
      throw new ConflictError(gate.reason ?? 'This order cannot be sent to Shopify.');
    }

    if (gate.decision === GateDecision.HOLD) {
      throw new ConflictError(
        gate.reason ?? 'This order is waiting on something before it can be sent.',
      );
    }

    if (order.status === CodOrderStatus.FAILED) {
      await repository.updateStatus(order.id, CodOrderStatus.CONFIRMED, { pushError: null });
    }

    // The previous job's id is released once BullMQ removes the failed job, so
    // this enqueues cleanly rather than deduplicating against the old one.
    const jobId = await enqueueOrderPush({
      codOrderId: order.id,
      shopDomain: auth.shopDomain,
      ...(auth.userId ? { triggeredBy: auth.userId } : {}),
    });

    await repository.appendEvent(
      order.id,
      'push.retry_requested',
      'A merchant asked for this order to be sent to Shopify again.',
      'merchant',
      { jobId },
    );

    await audit.recordForRequest(req, {
      action: 'order.push_retried',
      entity: 'CodOrder',
      entityId: order.id,
      after: { reference: order.reference, jobId },
    });

    accepted(res, { reference: order.reference, queued: jobId !== null, jobId });
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /api/admin/orders/:reference/verify`
 *
 * The merchant vouching for a customer's phone number, in place of an OTP.
 *
 * This exists because the automatic flow does not. Nothing sends a code yet, so
 * an order requiring verification waits forever with nothing able to release it
 * — and on plenty of COD stores the merchant rings the customer anyway, which is
 * a stronger check than an SMS to a number that may not be theirs.
 *
 * Recorded as `manual` on the timeline rather than as an OTP, because the two
 * are not the same evidence and an audit six months from now should be able to
 * tell them apart.
 */
export async function verifyOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const reference = req.params.reference as string;

    const order = await repository.findByReference(auth.shopId, reference);
    if (!order) throw new NotFoundError('Order not found');

    if (order.shopifyOrderGid) {
      throw new ConflictError(
        `This order is already in Shopify as ${order.shopifyOrderNumber ?? 'an order'}.`,
      );
    }

    const needsVerification =
      (order.otpRequired && !order.otpVerified) ||
      (order.riskAction === RiskAction.CHALLENGE_OTP && !order.otpVerified);

    if (!needsVerification) {
      // Not an error worth failing loudly on, but saying "verified" would be a
      // lie about an order nothing was waiting on.
      throw new ConflictError('This order is not waiting on phone verification.');
    }

    const verified = await repository.updateStatus(
      order.id,
      // Out of PENDING_OTP, because the order is now confirmed and pushable.
      // Any other status is left alone — a FAILED order stays failed, and its
      // retry is a separate decision.
      order.status === CodOrderStatus.PENDING_OTP ? CodOrderStatus.CONFIRMED : order.status,
      { otpVerified: true, otpVerifiedAt: new Date() },
    );

    await repository.appendEvent(
      order.id,
      'otp.verified_manually',
      'A merchant confirmed this phone number themselves.',
      'merchant',
      { verifiedBy: auth.userId ?? null },
    );

    await audit.recordForRequest(req, {
      action: 'order.verified_manually',
      entity: 'CodOrder',
      entityId: order.id,
      before: { otpVerified: false, status: order.status },
      after: { otpVerified: true, status: verified.status },
    });

    // Verification clears the OTP gate, not every gate. An order also held for
    // fraud review stays held, and saying so is what stops a merchant thinking
    // the push failed.
    const gate = evaluateGates(verified);
    let queued = false;

    if (gate.decision === GateDecision.ALLOW) {
      const jobId = await enqueueOrderPush({
        codOrderId: verified.id,
        shopDomain: auth.shopDomain,
        ...(auth.userId ? { triggeredBy: auth.userId } : {}),
      });
      queued = jobId !== null;
    }

    ok(res, {
      reference: verified.reference,
      otpVerified: true,
      queued,
      heldReason: gate.decision === GateDecision.ALLOW ? null : gate.reason,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Maximum a count will report before it becomes a floor.
 *
 * A merchant with more than a thousand stuck orders does not need the exact
 * figure — they need to know it is a flood, and then a bulk action. Counting
 * precisely past this point is a full scan on every page load of the screen
 * they refresh most when things are wrong.
 */
const COUNT_CAP = 1_000;

/** An order confirmed longer ago than this and never attempted looks unattended. */
const UNATTENDED_AFTER_MS = 5 * 60_000;

/**
 * `GET /api/admin/orders/stuck`
 *
 * One page of one group. The merchant's recovery list, and the first thing to
 * look at after an outage.
 *
 * Grouping is done here rather than in the browser because paging makes the
 * two incompatible: fetch fifty of a mixed list and the failures — the only
 * group needing action — can sit entirely on a later page. The counts come back
 * with every page so the tabs stay honest about what is not on screen.
 */
export async function listStuck(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const query = req.query as unknown as StuckQueryInput;

    const [page, failing, held, waiting, unattended] = await Promise.all([
      repository.findStuckPage(auth.shopId, query.group, query.limit, query.cursor ?? null),
      repository.countStuckCapped(auth.shopId, 'failing', COUNT_CAP),
      repository.countStuckCapped(auth.shopId, 'held', COUNT_CAP),
      repository.countStuckCapped(auth.shopId, 'waiting', COUNT_CAP),
      repository.hasUnattendedOrders(auth.shopId, new Date(Date.now() - UNATTENDED_AFTER_MS)),
    ]);

    const payload: StuckOrdersPage = {
      group: query.group,
      items: page.items.map((order) => ({
        reference: order.reference,
        status: order.status,
        total: order.total.toString(),
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        pushAttempts: order.pushAttempts,
        pushError: order.pushError,
        riskAction: order.riskAction,
        otpRequired: order.otpRequired,
        otpVerified: order.otpVerified,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      counts: {
        failing: failing.count,
        held: held.count,
        waiting: waiting.count,
        capped: failing.capped || held.capped || waiting.capped,
      },
      unattended,
    };

    ok(res, payload);
  } catch (error) {
    next(error);
  }
}


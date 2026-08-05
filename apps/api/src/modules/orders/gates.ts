import { CodOrderStatus, RiskAction, type CodOrder } from '@prisma/client';
import { createLogger } from '../../lib/logger';

const log = createLogger('order-gates');

/**
 * Conditions an order must clear before it reaches Shopify.
 *
 * These exist as one place with one shape because three separate phases add
 * conditions to the same decision, and without a shared seam each would grow
 * its own `if` inside the push pipeline until nobody could say what actually
 * blocks an order.
 *
 * The gates are read from the order's own columns rather than recomputed here.
 * That is the important property: the fraud engine writes `riskAction` when it
 * scores an order, the OTP flow writes `otpVerified` when a code is confirmed,
 * and this module only *reads* them. So Phases 7 and 8 land by populating
 * columns that already exist — they do not have to reach into the push path.
 */

export const GateDecision = {
  /** Push now. */
  ALLOW: 'allow',
  /** Do not push, and do not retry — something must change first. */
  HOLD: 'hold',
  /** Do not push, ever. Terminal. */
  BLOCK: 'block',
} as const;

export type GateDecision = (typeof GateDecision)[keyof typeof GateDecision];

export interface GateResult {
  readonly decision: GateDecision;
  /** Machine-readable, for the timeline and for metrics. */
  readonly code: string | null;
  /** Shown to the merchant on the order. */
  readonly reason: string | null;
}

const ALLOW: GateResult = { decision: GateDecision.ALLOW, code: null, reason: null };

/**
 * Evaluates every gate for an order.
 *
 * Ordered by finality: a blocked order is never pushed regardless of its OTP
 * state, so checking risk first avoids reporting "waiting for verification" on
 * an order that was already rejected.
 */
export function evaluateGates(order: CodOrder): GateResult {
  // ---- Terminal states. An order the merchant cancelled, or one that already
  // reached Shopify, must not be pushed by a stale retry.
  if (order.status === CodOrderStatus.CANCELLED) {
    return {
      decision: GateDecision.BLOCK,
      code: 'ORDER_CANCELLED',
      reason: 'This order was cancelled before it reached Shopify.',
    };
  }

  if (order.shopifyOrderGid) {
    return {
      decision: GateDecision.BLOCK,
      code: 'ALREADY_PUSHED',
      reason: 'This order is already in Shopify.',
    };
  }

  // ---- Risk. Written by the fraud engine (Phase 7). Until then every order
  // carries the schema default of ALLOW, so this is inert rather than absent —
  // the wiring is real, the scoring is not yet.
  if (order.riskAction === RiskAction.BLOCK) {
    return {
      decision: GateDecision.BLOCK,
      code: 'RISK_BLOCKED',
      reason: `Blocked by fraud rules (risk score ${order.riskScore}).`,
    };
  }

  if (order.riskAction === RiskAction.REVIEW) {
    return {
      decision: GateDecision.HOLD,
      code: 'AWAITING_REVIEW',
      reason: `Held for review (risk score ${order.riskScore}). Approve it to send it to Shopify.`,
    };
  }

  // ---- OTP. Written by the verification flow (Phase 8).
  if (order.otpRequired && !order.otpVerified) {
    return {
      decision: GateDecision.HOLD,
      code: 'AWAITING_OTP',
      reason: 'Waiting for the customer to verify their phone number.',
    };
  }

  if (order.riskAction === RiskAction.CHALLENGE_OTP && !order.otpVerified) {
    return {
      decision: GateDecision.HOLD,
      code: 'AWAITING_OTP',
      reason: 'Phone verification required before this order can be sent to Shopify.',
    };
  }

  return ALLOW;
}

/**
 * Whether an order is in a state worth enqueueing at all.
 *
 * Called at submission time so a held order does not occupy a queue slot and
 * burn retry attempts on a condition only a human or a later phase can clear.
 * A `HOLD` order is enqueued later, by whatever resolves the hold.
 */
export function shouldEnqueue(order: CodOrder): boolean {
  const result = evaluateGates(order);

  if (result.decision !== GateDecision.ALLOW) {
    log.info(
      { codOrderId: order.id, decision: result.decision, code: result.code },
      'Order not enqueued for push',
    );
  }

  return result.decision === GateDecision.ALLOW;
}

import type { Paginated } from './common.js';
import type { CodOrderStatus, RiskAction } from '../enums.js';

/**
 * The merchant-facing order contract.
 *
 * Scoped to push recovery, matching the endpoints that exist: full order
 * management is its own phase. This is the subset a merchant needs the day an
 * order does not reach Shopify — which is the one order problem they cannot
 * work around themselves, because the order is in CODkar, the customer is
 * expecting delivery, and the alternative is rekeying it by hand.
 *
 * Note what is absent: no name, no phone, no address. A recovery list is about
 * *which* orders are stuck and why, and shipping a shopper's personal details
 * into a screen that does not need them is how a support tool becomes a privacy
 * incident.
 */

/**
 * The three ways an order can be stuck.
 *
 * They are three different problems with three different fixes, which is why
 * they are separate queries rather than one list the client sorts. Grouping in
 * the browser only worked while every stuck order was fetched — with paging,
 * fifty held orders would bury the failures on a later page, and the failures
 * are the ones needing action.
 */
export const StuckOrderGroup = {
  /** Tried and did not arrive. */
  FAILING: 'failing',
  /** Waiting on a decision — fraud review, or phone verification. */
  HELD: 'held',
  /** Queued and untried. */
  WAITING: 'waiting',
} as const;

export type StuckOrderGroup = (typeof StuckOrderGroup)[keyof typeof StuckOrderGroup];

/** How many orders sit in each group. */
export interface StuckOrderCounts {
  readonly failing: number;
  readonly held: number;
  readonly waiting: number;
  /**
   * True when a count hit its ceiling and is a floor rather than a total.
   *
   * An exact count over a large table costs a full scan, and "1,000+" answers
   * the merchant's actual question — is this a handful or a flood — without it.
   */
  readonly capped: boolean;
}

/** One page of one group. */
export interface StuckOrdersPage extends Paginated<StuckOrderSummary> {
  readonly group: StuckOrderGroup;
  readonly counts: StuckOrderCounts;
  /**
   * True when something has been confirmed a while and never attempted.
   *
   * Computed server-side across every group rather than from the rows on
   * screen: the warning is about the queue, and it must not vanish because the
   * merchant happens to be looking at the failures tab.
   */
  readonly unattended: boolean;
}

/** One order that has not reached Shopify. */
export interface StuckOrderSummary {
  readonly reference: string;
  readonly status: CodOrderStatus;
  /** Decimal string. Never a float — money through a float loses paise. */
  readonly total: string;
  readonly currency: string;
  readonly createdAt: string;

  /**
   * Push attempts so far.
   *
   * Zero on a CONFIRMED order is the diagnostic that matters most: it means no
   * worker has ever picked the order up, which is a different problem from a
   * push that failed — and the commonest cause is `npm run dev:worker` not
   * running at all.
   */
  readonly pushAttempts: number;
  readonly pushError: string | null;

  readonly riskAction: RiskAction | null;
  readonly otpRequired: boolean;
  readonly otpVerified: boolean;
}

/** Why one order has not reached Shopify, and whether anything can be done. */
export interface OrderPushStatus {
  readonly reference: string;
  readonly status: CodOrderStatus;
  readonly shopifyOrderNumber: string | null;
  readonly shopifyOrderGid: string | null;
  readonly draftOrderGid: string | null;
  readonly pushedAt: string | null;
  readonly pushAttempts: number;
  readonly pushError: string | null;

  readonly gate: {
    readonly decision: string;
    readonly code: string | null;
    readonly reason: string | null;
  };

  /**
   * False when a gate blocks or holds the order.
   *
   * Lets the UI disable the retry and say why, rather than offering a button
   * that always fails.
   */
  readonly retryable: boolean;
}

/**
 * Result of a merchant vouching for a customer's phone number.
 *
 * Manual verification exists because the automatic one does not: nothing sends
 * a code yet, so an order requiring OTP would otherwise wait forever with no
 * action able to release it. A merchant who has phoned the customer is a
 * perfectly good verifier, and on many COD stores it is how it works anyway.
 */
export interface VerifyOrderResult {
  readonly reference: string;
  readonly otpVerified: boolean;
  /** False when a gate still holds the order — fraud review, typically. */
  readonly queued: boolean;
  /** Why it is still held, when it is. */
  readonly heldReason: string | null;
}

/** Result of asking for an order to be sent again. */
export interface RetryPushResult {
  readonly reference: string;
  /** False when the queue refused the job — the retry did not happen. */
  readonly queued: boolean;
  readonly jobId: string | null;
}

import {
  CodOrderStatus,
  Prisma,
  // A value, not just a type: `findStuck` filters on `RiskAction.BLOCK`.
  RiskAction,
  type CodOrder,
  type RiskLevel,
} from '@prisma/client';
import type { StuckOrderGroup } from '@codflow/shared';
import { prisma } from '../../db/prisma';

/**
 * COD order persistence.
 *
 * A `CodOrder` exists before a Shopify order does — the form is submitted, the
 * risk engine scores it, OTP may be pending — which is why it carries its own
 * status enum rather than mirroring Shopify's financial and fulfilment states.
 */

export interface CreateCodOrderInput {
  shopId: string;
  reference: string;
  status: CodOrderStatus;

  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string;
  phoneE164: string | null;

  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  countryCode: string | null;
  postalCode: string | null;
  addressHash: string | null;
  orderNotes: string | null;

  lineItems: Prisma.InputJsonValue;
  currency: string;
  subtotal: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  codFee: Prisma.Decimal;
  discount: Prisma.Decimal;
  total: Prisma.Decimal;
  discountCode: string | null;

  customFields: Prisma.InputJsonValue;

  ipAddress: string | null;
  userAgent: string | null;
  referrer: string | null;
  landingPage: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  deviceFingerprint: string | null;
  clientId: string | null;
  fbp: string | null;
  fbc: string | null;
  ttclid: string | null;
  gclid: string | null;

  /** Snapshot of the tick-box add-ons accepted, and their combined price. */
  selectedBumps: Prisma.InputJsonValue;
  bumpTotal: Prisma.Decimal;

  marketingConsent: boolean;
  analyticsConsent: boolean;
  saleOfDataConsent: boolean;

  /**
   * The shopper's refusal of automated risk decisions.
   *
   * Written at creation rather than left to the column default, for the same
   * reason the verdict below is: a rescan reads it off the saved order, and a
   * window in which it says `false` is a window in which the refusal is lost.
   */
  profilingOptOut: boolean;

  otpRequired: boolean;

  /**
   * The fraud verdict, denormalized onto the order.
   *
   * Written at creation rather than by a follow-up update, so there is no
   * window in which an order exists carrying the schema default of ALLOW. The
   * push gates read these columns, and a job firing during that window would
   * send a high-risk order to Shopify before the assessment landed.
   */
  riskScore: number;
  riskLevel: RiskLevel;
  riskAction: RiskAction;
}

/**
 * Creates the order and its first timeline entry together.
 *
 * One transaction because an order with no timeline is a support problem: the
 * merchant opens it, sees no history, and cannot tell whether it was placed by
 * a customer or created by an automation.
 */
export async function createWithTimeline(
  input: CreateCodOrderInput,
  timelineMessage: string,
): Promise<CodOrder> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.codOrder.create({ data: input });

    await tx.codOrderEvent.create({
      data: {
        codOrderId: order.id,
        type: 'order.created',
        message: timelineMessage,
        actor: 'customer',
        data: {
          reference: order.reference,
          total: order.total.toString(),
          currency: order.currency,
        },
      },
    });

    return order;
  });
}

export function appendEvent(
  codOrderId: string,
  type: string,
  message: string,
  actor: string,
  data: Prisma.InputJsonValue = {},
): Promise<{ id: string }> {
  return prisma.codOrderEvent.create({
    data: { codOrderId, type, message, actor, data },
    select: { id: true },
  });
}

export function findById(id: string): Promise<CodOrder | null> {
  return prisma.codOrder.findUnique({ where: { id } });
}

/**
 * The COD order behind a Shopify order, if CODkar created it.
 *
 * How every order webhook finds its way back to a CODkar record. A null here
 * is ordinary traffic, not an error: the merchant's other orders — from their
 * normal checkout, from a POS, from another app — all deliver the same
 * webhooks, and none of them are ours to act on.
 */
export function findByShopifyGid(shopId: string, shopifyOrderGid: string): Promise<CodOrder | null> {
  return prisma.codOrder.findFirst({ where: { shopId, shopifyOrderGid } });
}

/**
 * Orders a fraud rescan could still change.
 *
 * Excludes anything already in Shopify — re-scoring a shipped order changes a
 * number nobody can act on, and could contradict a decision the merchant has
 * already carried out. Ordered newest first because a merchant adding a block
 * list entry is usually reacting to something that just happened.
 */
export function findRescannable(shopId: string, limit: number): Promise<CodOrder[]> {
  return prisma.codOrder.findMany({
    where: {
      shopId,
      shopifyOrderGid: null,
      status: {
        in: [CodOrderStatus.CONFIRMED, CodOrderStatus.PENDING_OTP, CodOrderStatus.DRAFT],
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function findByReference(shopId: string, reference: string): Promise<CodOrder | null> {
  return prisma.codOrder.findFirst({ where: { shopId, reference } });
}

/**
 * True when this exact submission was already accepted moments ago.
 *
 * Double-submission is ordinary on a slow mobile connection: the shopper taps
 * once, sees nothing happen, and taps again. Without this the merchant gets two
 * identical orders and dispatches both.
 *
 * Matched on phone plus total rather than on a client-supplied idempotency key,
 * because the retry usually comes from a *fresh page load* after the shopper
 * gave up and reloaded — which would carry a different key.
 */
export async function findRecentDuplicate(
  shopId: string,
  phone: string,
  total: Prisma.Decimal,
  withinSeconds: number,
): Promise<CodOrder | null> {
  const since = new Date(Date.now() - withinSeconds * 1_000);

  return prisma.codOrder.findFirst({
    where: {
      shopId,
      phone,
      total,
      createdAt: { gte: since },
      status: { notIn: [CodOrderStatus.CANCELLED, CodOrderStatus.FAILED] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** True when a reference is already taken. Used by the generator's retry loop. */
export async function referenceExists(reference: string): Promise<boolean> {
  const existing = await prisma.codOrder.findUnique({
    where: { reference },
    select: { id: true },
  });
  return existing !== null;
}

/**
 * Orders that never reached Shopify.
 *
 * The merchant's recovery list. Deliberately includes `PENDING_OTP` alongside
 * the failures: from the merchant's point of view an order stuck waiting for a
 * verification the customer abandoned is just as unfulfilled as one whose push
 * errored, and hiding it under a different status is how those quietly
 * accumulate.
 */
/**
 * Orders that never reached Shopify, before grouping.
 *
 * Blocked orders are excluded to match `analytics/repository.liveCounters`,
 * which the dashboard tile counts. If the two filters diverge the tile says
 * three and the screen it links to lists four — and the extra row carries a
 * retry that can never succeed, because a BLOCK gate is terminal.
 */
function stuckBase(shopId: string): Prisma.CodOrderWhereInput {
  return {
    shopId,
    shopifyOrderGid: null,
    status: {
      in: [CodOrderStatus.CONFIRMED, CodOrderStatus.FAILED, CodOrderStatus.PENDING_OTP],
    },
    riskAction: { not: RiskAction.BLOCK },
  };
}

/**
 * Orders a gate is holding.
 *
 * Exported and pure so the grouping can be tested without a database — these
 * three predicates have to partition the stuck set exactly, and an order
 * falling into two groups or none is the kind of bug a merchant only notices
 * as a missing order.
 */
export function heldWhere(): Prisma.CodOrderWhereInput {
  return {
    OR: [
      { riskAction: { in: [RiskAction.REVIEW, RiskAction.CHALLENGE_OTP] } },
      { AND: [{ otpRequired: true }, { otpVerified: false }] },
    ],
  };
}

/**
 * Tried and did not arrive.
 *
 * `pushAttempts > 0` as well as `FAILED`, because the status column only
 * reaches FAILED on some paths — an order can sit at CONFIRMED with five
 * attempts behind it, and calling that "queued" tells a merchant to wait for
 * something that is not coming.
 */
export function failingWhere(): Prisma.CodOrderWhereInput {
  return {
    NOT: heldWhere(),
    OR: [{ status: CodOrderStatus.FAILED }, { pushAttempts: { gt: 0 } }],
  };
}

/** Queued and untried. The complement of the other two. */
export function waitingWhere(): Prisma.CodOrderWhereInput {
  return {
    NOT: heldWhere(),
    status: { not: CodOrderStatus.FAILED },
    pushAttempts: 0,
  };
}

export function groupWhere(group: StuckOrderGroup): Prisma.CodOrderWhereInput {
  if (group === 'failing') return failingWhere();
  if (group === 'held') return heldWhere();
  return waitingWhere();
}

const STUCK_COLUMNS = {
  reference: true,
  status: true,
  total: true,
  currency: true,
  createdAt: true,
  pushAttempts: true,
  pushError: true,
  riskAction: true,
  otpRequired: true,
  otpVerified: true,
} as const;

/**
 * One page of one group.
 *
 * Cursor rather than offset: COD orders arrive continuously, and with
 * `LIMIT/OFFSET` a row inserted while the merchant pages shifts every
 * subsequent page and silently hides a record. `id` breaks ties on
 * `createdAt`, without which two orders created in the same millisecond can
 * repeat or vanish across a page boundary.
 */
export async function findStuckPage(
  shopId: string,
  group: StuckOrderGroup,
  limit: number,
  cursor: string | null,
) {
  const rows = await prisma.codOrder.findMany({
    where: { AND: [stuckBase(shopId), groupWhere(group)] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One more than asked for, so `hasMore` is known without a second query.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, ...STUCK_COLUMNS },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return { items, hasMore, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
}

/**
 * How many orders are in a group, up to a ceiling.
 *
 * `count()` over a large filtered set is a full index scan, and it runs on
 * every load of a screen a merchant refreshes when things are going wrong —
 * exactly when the table is largest. Selecting ids up to `cap + 1` is bounded
 * work that still answers "a handful or a flood".
 */
export async function countStuckCapped(
  shopId: string,
  group: StuckOrderGroup,
  cap: number,
): Promise<{ count: number; capped: boolean }> {
  const rows = await prisma.codOrder.findMany({
    where: { AND: [stuckBase(shopId), groupWhere(group)] },
    take: cap + 1,
    select: { id: true },
  });

  return { count: Math.min(rows.length, cap), capped: rows.length > cap };
}

/**
 * Whether anything has been confirmed a while and never attempted.
 *
 * The worker-not-running signal. `findFirst` rather than a count because the
 * answer is a boolean and one row proves it.
 */
export async function hasUnattendedOrders(shopId: string, olderThan: Date): Promise<boolean> {
  const row = await prisma.codOrder.findFirst({
    where: {
      AND: [stuckBase(shopId), waitingWhere()],
      status: CodOrderStatus.CONFIRMED,
      createdAt: { lt: olderThan },
    },
    select: { id: true },
  });

  return row !== null;
}


export function updateStatus(
  id: string,
  status: CodOrderStatus,
  data: Prisma.CodOrderUpdateInput = {},
): Promise<CodOrder> {
  return prisma.codOrder.update({ where: { id }, data: { ...data, status } });
}

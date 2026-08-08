import { CodOrderStatus, Prisma, type CodOrder } from '@prisma/client';
import type { Session } from '@shopify/shopify-api';
import { prisma } from '../../db/prisma';
import { createLogger } from '../../lib/logger';
import { adminGraphql, assertNoUserErrors } from '../../shopify/graphql';
import {
  DRAFT_ORDER_COMPLETE_MUTATION,
  DRAFT_ORDER_CREATE_MUTATION,
  ORDER_TAGS_ADD_MUTATION,
  type DraftOrderCompleteResponse,
  type DraftOrderCreateResponse,
  type DraftOrderInput,
  type DraftOrderLineItemInput,
  type MailingAddressInput,
  type TagsAddResponse,
} from '../../shopify/mutations/draftOrder';
import { loadOfflineSession } from '../../shopify/sessionStorage';
import { ReauthRequiredError, ShopifyApiError, toError } from '../../lib/errors';
import { enqueuePixelEvent, enqueueSheetSync } from '../../queue/queues';
import * as stats from '../analytics/stats';
import * as repository from './repository';
import { GateDecision, evaluateGates } from './gates';
import type { ResolvedLineItem } from './pricing';

const log = createLogger('order-push');

/**
 * Delivery of a COD order into the merchant's Shopify admin.
 *
 * Runs in a BullMQ worker rather than on the shopper's request, for two
 * reasons. Shopify can be slow or throttled, and a shopper should not watch a
 * spinner while the app negotiates with an API they have no relationship with.
 * And a push that fails deserves retries with backoff — which is not something
 * you can offer inside a request that has already returned.
 *
 * The shopper's receipt is the CODkar reference, issued synchronously. The
 * Shopify order number appears moments later and is what the merchant works
 * from.
 */

export interface PushResult {
  readonly pushed: boolean;
  readonly shopifyOrderGid: string | null;
  readonly shopifyOrderNumber: string | null;
  readonly draftOrderGid: string | null;
  /** Set when a gate held or blocked the order rather than a failure occurring. */
  readonly gated: string | null;
}

/** Settings the push needs. Read fresh — a retry may run long after submission. */
async function loadPushSettings(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      domain: true,
      currencyCode: true,
      settings: {
        select: {
          defaultOrderTags: true,
          createAsDraftOrder: true,
          sendShopifyOrderConfirmation: true,
          codFeeEnabled: true,
        },
      },
    },
  });

  return shop;
}

/**
 * Splits a stored line-item array back into Shopify inputs.
 *
 * The array on the order is the *resolved* one written at submission — the
 * prices in it came from Shopify, not from the browser. Catalogue lines are
 * sent by `variantId` so Shopify re-derives the current price itself; only the
 * fee lines carry an explicit amount, because they are CODkar's own charges
 * and Shopify has no record of them.
 */
function toShopifyLineItems(
  order: CodOrder,
  currencyCode: string,
): DraftOrderLineItemInput[] {
  const stored = Array.isArray(order.lineItems)
    ? (order.lineItems as unknown as ResolvedLineItem[])
    : [];

  const lines: DraftOrderLineItemInput[] = stored.map((item) => ({
    variantId: item.variantGid,
    quantity: item.quantity,
  }));

  // Delivery and the COD fee become custom lines rather than a shipping line.
  // A shipping line would be overwritten the moment the merchant edits the
  // order in Shopify, and the amount the courier collects would then differ
  // from what the customer agreed to on the form.
  const shipping = new Prisma.Decimal(order.shippingFee);
  if (shipping.greaterThan(0)) {
    lines.push({
      title: 'Delivery',
      quantity: 1,
      requiresShipping: false,
      taxable: false,
      originalUnitPriceWithCurrency: { amount: shipping.toString(), currencyCode },
    });
  }

  const codFee = new Prisma.Decimal(order.codFee);
  if (codFee.greaterThan(0)) {
    lines.push({
      title: 'Cash on delivery fee',
      quantity: 1,
      requiresShipping: false,
      taxable: false,
      originalUnitPriceWithCurrency: { amount: codFee.toString(), currencyCode },
    });
  }

  /**
   * Each accepted add-on becomes its own custom line, named as the shopper saw
   * it. One combined "Extras" line would total correctly and tell the merchant
   * nothing about what to actually pack — and gift wrapping and shipping
   * protection need different things done about them.
   *
   * Read from the order's own snapshot rather than from `OrderBump`, so a
   * merchant who renames or deletes a bump does not rewrite the history of what
   * a shopper agreed to.
   */
  const bumps = Array.isArray(order.selectedBumps) ? order.selectedBumps : [];

  for (const entry of bumps as { title?: unknown; price?: unknown }[]) {
    const amount = new Prisma.Decimal(String(entry?.price ?? 0));
    if (!amount.greaterThan(0)) continue;

    lines.push({
      title: String(entry?.title ?? 'Add-on'),
      quantity: 1,
      requiresShipping: false,
      taxable: false,
      originalUnitPriceWithCurrency: { amount: amount.toString(), currencyCode },
    });
  }

  return lines;
}

function toAddress(order: CodOrder): MailingAddressInput | undefined {
  // Shopify rejects an address with no lines at all, and a COD order without
  // one cannot be delivered — but the form may legitimately omit address fields
  // for a digital or pickup product, so this degrades rather than throws.
  if (!order.address1 && !order.city) return undefined;

  return {
    ...(order.firstName ? { firstName: order.firstName } : {}),
    ...(order.lastName ? { lastName: order.lastName } : {}),
    ...(order.address1 ? { address1: order.address1 } : {}),
    ...(order.address2 ? { address2: order.address2 } : {}),
    ...(order.city ? { city: order.city } : {}),
    ...(order.province ? { provinceCode: order.province } : {}),
    ...(order.countryCode ? { countryCode: order.countryCode } : {}),
    ...(order.postalCode ? { zip: order.postalCode } : {}),
    ...(order.phoneE164 ? { phone: order.phoneE164 } : {}),
  };
}

/**
 * Custom fields, carried onto the Shopify order as attributes.
 *
 * This is how a merchant sees the answers to the questions they added in the
 * form builder. Without it those values live only in CODkar, and the person
 * packing the box — who works from the Shopify order — never sees the delivery
 * instructions the customer wrote.
 */
function toCustomAttributes(order: CodOrder): Array<{ key: string; value: string }> {
  const attributes: Array<{ key: string; value: string }> = [
    { key: 'CODkar reference', value: order.reference },
  ];

  const custom =
    typeof order.customFields === 'object' && order.customFields !== null
      ? (order.customFields as Record<string, unknown>)
      : {};

  for (const [key, value] of Object.entries(custom)) {
    if (value === null || value === undefined || value === '') continue;

    attributes.push({
      key: key.slice(0, 40),
      // Shopify caps attribute values; truncating is better than the whole
      // mutation failing because one note was long.
      value: String(Array.isArray(value) ? value.join(', ') : value).slice(0, 255),
    });
  }

  return attributes;
}

/**
 * Pushes one order.
 *
 * Idempotency is layered. The queue deduplicates by job id, the gates refuse an
 * order that already carries a `shopifyOrderGid`, and the draft id is persisted
 * the moment it exists — so a crash between create and complete resumes at
 * complete rather than creating a second draft.
 */
export async function pushOrder(codOrderId: string): Promise<PushResult> {
  const order = await prisma.codOrder.findUnique({ where: { id: codOrderId } });

  if (!order) {
    // Redacted or deleted between enqueue and execution. Not an error worth
    // retrying — there is nothing to push.
    log.warn({ codOrderId }, 'Order no longer exists — nothing to push');
    return { pushed: false, shopifyOrderGid: null, shopifyOrderNumber: null, draftOrderGid: null, gated: 'NOT_FOUND' };
  }

  const gate = evaluateGates(order);

  if (gate.decision !== GateDecision.ALLOW) {
    await repository.appendEvent(
      order.id,
      gate.decision === GateDecision.BLOCK ? 'push.blocked' : 'push.held',
      gate.reason ?? 'Order is not eligible to be sent to Shopify.',
      'system',
      { code: gate.code },
    );

    return {
      pushed: false,
      shopifyOrderGid: null,
      shopifyOrderNumber: null,
      draftOrderGid: order.shopifyDraftOrderGid,
      gated: gate.code,
    };
  }

  const shopRecord = await loadPushSettings(order.shopId);
  const settings = shopRecord?.settings;

  if (!shopRecord || !settings) {
    throw new Error(`Shop ${order.shopId} has no settings — cannot push order ${order.reference}`);
  }

  // Rebuilt with `settings` narrowed, so it can be passed whole to the helpers
  // below without each of them re-checking a guard that already ran.
  const shop = { ...shopRecord, settings };

  const session = await loadOfflineSession(shop.domain);

  if (!session) {
    // Uninstalled, or the token was revoked. Throwing lets BullMQ retry with
    // backoff — a reinstall restores the session and the backlog drains.
    throw new ReauthRequiredError(shop.domain, 'no offline session available for order push');
  }

  await prisma.codOrder.update({
    where: { id: order.id },
    data: { pushAttempts: { increment: 1 } },
  });

  try {
    const draftGid = order.shopifyDraftOrderGid ?? (await createDraft(session, order, shop));

    // Persisted immediately: if completing fails, the retry must reuse this
    // draft instead of creating a second one and double-charging the customer.
    if (!order.shopifyDraftOrderGid) {
      await prisma.codOrder.update({
        where: { id: order.id },
        data: { shopifyDraftOrderGid: draftGid },
      });
    }

    if (shop.settings.createAsDraftOrder) {
      // The merchant reviews and completes it themselves in Shopify.
      await repository.updateStatus(order.id, CodOrderStatus.PUSHED_TO_SHOPIFY, {
        pushedAt: new Date(),
        pushError: null,
      });

      await repository.appendEvent(
        order.id,
        'push.draft_created',
        'Created as a draft order in Shopify for review.',
        'system',
        { draftOrderGid: draftGid },
      );

      log.info({ reference: order.reference, draftGid }, 'Draft order created');

      return {
        pushed: true,
        shopifyOrderGid: null,
        shopifyOrderNumber: null,
        draftOrderGid: draftGid,
        gated: null,
      };
    }

    const completed = await completeDraft(session, draftGid);

    await repository.updateStatus(order.id, CodOrderStatus.PUSHED_TO_SHOPIFY, {
      shopifyOrderGid: completed.orderGid,
      shopifyOrderNumber: completed.orderName,
      shopifyCustomerGid: completed.customerGid,
      orderStatusUrl: completed.orderStatusUrl,
      pushedAt: new Date(),
      pushError: null,
    });

    await applyTags(session, completed.orderGid, shop.settings.defaultOrderTags, order);

    await repository.appendEvent(
      order.id,
      'push.completed',
      `Sent to Shopify as order ${completed.orderName}.`,
      'system',
      { shopifyOrderGid: completed.orderGid, orderNumber: completed.orderName },
    );

    // Sheets sync is chained off a successful push rather than off submission,
    // so the row carries the Shopify order number the merchant will actually
    // work from. Syncing at submission would write a blank in that column and
    // never fill it in.
    await enqueueSheetSync({ codOrderId: order.id, shopDomain: shop.domain });

    // The Purchase event fires once the order genuinely exists in Shopify, not
    // at form submission. A COD order that fails to push is not a sale, and
    // reporting one would teach the merchant's ad platforms to bid on
    // conversions that never happened.
    await enqueuePixelEvent({
      codOrderId: order.id,
      shopDomain: shop.domain,
      eventName: 'PURCHASE',
    });

    // Counted on the day it reached Shopify, which is usually — but not always —
    // the day it was placed. An order held overnight for OTP belongs to
    // yesterday's revenue and today's pushes.
    await stats.recordOrderPushed(order);

    log.info(
      { reference: order.reference, orderNumber: completed.orderName },
      'Order pushed to Shopify',
    );

    return {
      pushed: true,
      shopifyOrderGid: completed.orderGid,
      shopifyOrderNumber: completed.orderName,
      draftOrderGid: draftGid,
      gated: null,
    };
  } catch (error) {
    const failure = toError(error);

    await prisma.codOrder.update({
      where: { id: order.id },
      data: { pushError: failure.message.slice(0, 1_000) },
    });

    await repository.appendEvent(
      order.id,
      'push.failed',
      `Could not send to Shopify: ${failure.message}`,
      'system',
      { attempt: order.pushAttempts + 1 },
    );

    // Rethrown so BullMQ records the attempt and schedules a backoff. The
    // terminal FAILED status is set by the job's `failed` handler, once the
    // retries are exhausted — setting it here would mark an order failed that
    // is about to succeed on its next attempt.
    throw error;
  }
}

async function createDraft(
  session: Session,
  order: CodOrder,
  shop: { currencyCode: string; settings: { defaultOrderTags: string[] } },
): Promise<string> {
  const address = toAddress(order);

  const input: DraftOrderInput = {
    ...(order.email ? { email: order.email } : {}),
    ...(order.phoneE164 ? { phone: order.phoneE164 } : {}),
    note: [
      `CODkar reference: ${order.reference}`,
      order.orderNotes ? `Customer note: ${order.orderNotes}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    tags: shop.settings.defaultOrderTags,
    lineItems: toShopifyLineItems(order, shop.currencyCode),
    ...(address ? { shippingAddress: address, billingAddress: address } : {}),
    customAttributes: toCustomAttributes(order),
  };

  const response = await adminGraphql<DraftOrderCreateResponse>(
    session,
    DRAFT_ORDER_CREATE_MUTATION,
    { variables: { input } },
  );

  assertNoUserErrors(response.draftOrderCreate.userErrors, 'draftOrderCreate');

  const draft = response.draftOrderCreate.draftOrder;

  if (!draft) {
    throw new ShopifyApiError('Shopify accepted the draft order but returned nothing');
  }

  return draft.id;
}

async function completeDraft(
  session: Session,
  draftGid: string,
): Promise<{
  orderGid: string;
  orderName: string;
  customerGid: string | null;
  orderStatusUrl: string | null;
}> {
  const response = await adminGraphql<DraftOrderCompleteResponse>(
    session,
    DRAFT_ORDER_COMPLETE_MUTATION,
    // `paymentPending: true` is what makes this cash on delivery rather than an
    // attempted capture against a payment method that does not exist.
    { variables: { id: draftGid, paymentPending: true } },
  );

  assertNoUserErrors(response.draftOrderComplete.userErrors, 'draftOrderComplete');

  const order = response.draftOrderComplete.draftOrder?.order;

  if (!order) {
    throw new ShopifyApiError('Shopify completed the draft but returned no order');
  }

  return {
    orderGid: order.id,
    orderName: order.name,
    customerGid: order.customer?.id ?? null,
    // Captured here or lost: the status page's token is not derivable from the
    // order id, so there is no way to reconstruct this URL afterwards.
    orderStatusUrl: order.statusPageUrl ?? null,
  };
}

/**
 * Tags the created order.
 *
 * Failure here is logged but not rethrown. The order exists in Shopify and the
 * merchant can fulfil it; retrying the whole push to fix a missing tag would
 * risk creating a second order, which is a far worse outcome than an untagged
 * one.
 */
async function applyTags(
  session: Session,
  orderGid: string,
  defaultTags: string[],
  order: CodOrder,
): Promise<void> {
  const tags = [...new Set([...defaultTags, `CODkar-${order.reference}`])].filter(Boolean);

  if (tags.length === 0) return;

  try {
    const response = await adminGraphql<TagsAddResponse>(session, ORDER_TAGS_ADD_MUTATION, {
      variables: { id: orderGid, tags },
    });

    assertNoUserErrors(response.tagsAdd.userErrors, 'tagsAdd');
  } catch (error) {
    log.warn(
      { err: toError(error), reference: order.reference },
      'Order created but tagging failed',
    );
  }
}

/**
 * Marks an order permanently failed after retries are exhausted.
 *
 * Separated from `pushOrder` so the status is only written once BullMQ has
 * given up — an order marked FAILED on its first transient error would look
 * broken to the merchant while it was still going to succeed.
 */
export async function markPushExhausted(codOrderId: string, message: string): Promise<void> {
  await repository.updateStatus(codOrderId, CodOrderStatus.FAILED, {
    pushError: message.slice(0, 1_000),
  });

  await repository.appendEvent(
    codOrderId,
    'push.exhausted',
    'Could not be sent to Shopify after several attempts. Retry it manually once the cause is fixed.',
    'system',
    { lastError: message.slice(0, 500) },
  );
}

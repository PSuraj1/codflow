import { createLogger } from '../../../lib/logger';
import * as mailer from '../../../lib/mailer';
import * as shopRepository from '../../shop/repository';
import * as audit from '../../audit/service';
import { readId, readString, type WebhookHandler } from './types';

const log = createLogger('webhook:customers/data_request');

/**
 * `customers/data_request` — a shopper asked what the app holds about them.
 *
 * Shopify's obligation model is worth being precise about: the *merchant* owes
 * the shopper an answer, and the app owes the merchant the portion of that
 * answer it holds, within 30 days. The app does not respond to the shopper
 * directly and must not — it has no relationship with them and no way to
 * verify who they are.
 *
 * So this handler assembles the export and sends it to the merchant. Delivery
 * is best-effort by design: when SMTP is not configured the export is not lost,
 * because the data it describes is still in the database and the audit row
 * records that a request arrived. An operator can fulfil it manually from that
 * record, which is the honest fallback — silently dropping the request would
 * leave the merchant out of compliance without ever telling them.
 */
export const customersDataRequest: WebhookHandler = async (context) => {
  const customer = (context.payload.customer ?? {}) as Record<string, unknown>;

  const email = readString(customer, 'email');
  const phone = readString(customer, 'phone');
  const customerId = readId(customer, 'id');
  const shopifyCustomerGid = customerId ? `gid://shopify/Customer/${customerId}` : null;

  const collected = await shopRepository.collectCustomerData(context.shopDomain, {
    email,
    phone,
    shopifyCustomerGid,
  });

  const orders = collected?.orders ?? [];

  await audit.record({
    shopId: context.shopId,
    action: audit.AuditAction.CUSTOMER_DATA_REQUESTED,
    entity: 'CodOrder',
    actor: audit.AuditActor.SHOPIFY,
    // Counts and the Shopify customer id only — enough to locate the request
    // again, without copying the shopper's contact details into a second table.
    after: {
      shopifyCustomerId: customerId,
      ordersFound: orders.length,
      webhookId: context.webhookId,
    },
  });

  if (orders.length === 0) {
    log.info({ shop: context.shopDomain }, 'Data request matched no COD orders');
    return;
  }

  const recipient = await resolveMerchantEmail(context.shopId);

  if (!recipient) {
    log.warn(
      { shop: context.shopDomain, orders: orders.length, webhookId: context.webhookId },
      'Data request has data to deliver but the shop has no notification email — fulfil manually',
    );
    return;
  }

  const export_ = {
    generatedAt: new Date().toISOString(),
    app: 'CODkar',
    shopDomain: context.shopDomain,
    shopifyCustomerId: customerId,
    requestedVia: 'Shopify customers/data_request',
    codOrders: orders,
  };

  const sent = await mailer.send({
    to: recipient,
    subject: `[CODkar] Customer data request — ${orders.length} record(s)`,
    text:
      `Shopify forwarded a customer data request for your store ${context.shopDomain}.\n\n` +
      `CODkar holds ${orders.length} cash-on-delivery order(s) for this customer. ` +
      `The full export is attached as JSON.\n\n` +
      `You have 30 days from the request date to provide this to the customer.\n\n` +
      `Shopify customer id: ${customerId ?? 'not supplied'}\n` +
      `Webhook id: ${context.webhookId}\n`,
    attachments: [
      {
        filename: `codflow-data-request-${context.webhookId}.json`,
        content: JSON.stringify(export_, null, 2),
        contentType: 'application/json',
      },
    ],
  });

  log.info(
    { shop: context.shopDomain, orders: orders.length, delivered: sent },
    'Customer data export prepared',
  );
};

/** The export goes to the merchant, never to the shopper. */
async function resolveMerchantEmail(shopId: string | null): Promise<string | null> {
  if (!shopId) return null;
  return shopRepository.findNotificationEmail(shopId);
}

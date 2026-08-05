import { createLogger } from '../../../lib/logger';
import * as shopRepository from '../../shop/repository';
import * as audit from '../../audit/service';
import { readId, readString, type WebhookHandler } from './types';

const log = createLogger('webhook:customers/redact');

/**
 * `customers/redact` — erase one shopper's personal data.
 *
 * Payload shape:
 *
 *   { "shop_domain": "...",
 *     "customer": { "id": 123, "email": "...", "phone": "..." },
 *     "orders_to_redact": [ ... ] }
 *
 * The design decision here is *blank, do not delete*. Deleting the COD orders
 * would take the merchant's revenue history with them — their dashboard totals
 * for last quarter would silently change because a shopper exercised a right
 * that has nothing to do with the merchant's accounting. So the rows survive
 * with every identifying column cleared. What remains (amounts, timestamps,
 * product ids) is not personal data and is exactly what analytics reads.
 *
 * Shopify also sends `orders_to_redact`, but this app's own `CodOrder` records
 * are keyed on the shopper's contact details rather than on Shopify order ids —
 * a COD order exists before a Shopify order does — so matching on identity
 * covers strictly more records than matching on that list would.
 */
export const customersRedact: WebhookHandler = async (context) => {
  const customer = (context.payload.customer ?? {}) as Record<string, unknown>;

  const email = readString(customer, 'email');
  const phone = readString(customer, 'phone');
  const customerId = readId(customer, 'id');
  const shopifyCustomerGid = customerId ? `gid://shopify/Customer/${customerId}` : null;

  const redacted = await shopRepository.redactCustomer(context.shopDomain, {
    email,
    phone,
    shopifyCustomerGid,
  });

  await audit.record({
    shopId: context.shopId,
    action: audit.AuditAction.CUSTOMER_REDACTED,
    entity: 'CodOrder',
    actor: audit.AuditActor.SHOPIFY,
    // Counts only. Recording which email was erased would recreate, in a table
    // the app keeps indefinitely, the very identifier it was asked to remove.
    after: { ordersRedacted: redacted, webhookId: context.webhookId },
  });

  log.info(
    { shop: context.shopDomain, orders: redacted },
    'Customer personal data cleared from COD orders',
  );
};

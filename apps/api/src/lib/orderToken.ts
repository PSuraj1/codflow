import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config } from '../config/env';

/**
 * A bearer token for one order's public status.
 *
 * The COD form needs to poll for "has this order reached Shopify yet, and what
 * is its order-status URL" so it can send the shopper to Shopify's own thank-you
 * page. That endpoint is unauthenticated — it is called from a storefront — and
 * an order *reference* is not a secret: `CF-XXXXXXXX` over a small alphabet is
 * guessable, and Shopify's order status page carries the customer's name,
 * address and phone.
 *
 * So the reference alone must never be enough. This token is issued in the
 * submit response, to the one browser that placed the order, and is required to
 * read that order's status. It is signed rather than stored: verifying costs an
 * HMAC instead of a database round trip on a polling endpoint.
 *
 * Deliberately short-lived. Its only job is to cover the seconds between
 * submitting and the push completing; a token that outlived that would be a
 * durable capability sitting in a page a shopper might share.
 */

const VERSION = 'o1';
const TOKEN_TTL_SECONDS = 15 * 60;

interface OrderTokenPayload {
  readonly reference: string;
  readonly shop: string;
  readonly issuedAt: number;
  readonly nonce: string;
}

function sign(body: string): string {
  return createHmac('sha256', config.security.sessionSecret).update(body).digest('base64url');
}

export function issueOrderToken(shop: string, reference: string): string {
  const payload: OrderTokenPayload = {
    reference,
    shop,
    issuedAt: Math.floor(Date.now() / 1_000),
    nonce: randomBytes(9).toString('base64url'),
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${VERSION}.${body}.${sign(body)}`;
}

export interface OrderTokenVerification {
  readonly valid: boolean;
  readonly reference: string | null;
}

/**
 * Verifies a token against the shop and reference it claims to cover.
 *
 * Both are checked, not just the signature: a valid token for *another* order
 * on the same shop would otherwise read that order's status. Comparison is
 * constant-time, because a signature check that leaks its position under timing
 * is a signature check that can be brute-forced.
 */
export function verifyOrderToken(
  token: string,
  expectedShop: string,
  expectedReference: string,
): OrderTokenVerification {
  const invalid: OrderTokenVerification = { valid: false, reference: null };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return invalid;

  const [, body, signature] = parts as [string, string, string];

  const expected = Buffer.from(sign(body), 'utf8');
  const provided = Buffer.from(signature, 'utf8');

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return invalid;

  let payload: OrderTokenPayload;

  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OrderTokenPayload;
  } catch {
    return invalid;
  }

  if (payload.shop !== expectedShop) return invalid;
  if (payload.reference !== expectedReference) return invalid;

  const age = Math.floor(Date.now() / 1_000) - payload.issuedAt;
  if (age > TOKEN_TTL_SECONDS || age < -60) return invalid;

  return { valid: true, reference: payload.reference };
}

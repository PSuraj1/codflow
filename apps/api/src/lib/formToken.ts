import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config } from '../config/env';

/**
 * Short-lived tokens binding a submission to a form that was actually served.
 *
 * The order endpoint is public — a shopper has no credentials — so without this
 * anyone could POST straight at it in a loop and manufacture COD orders. The
 * token does not authenticate the *shopper*; it proves the submission followed
 * a real form render, which raises the cost of automated abuse from "one curl
 * command" to "fetch a token first, and do it again every ten minutes".
 *
 * It carries the issue time, so the fill-duration check has a value the client
 * cannot simply lie about — a hidden timestamp input can be edited in devtools,
 * this one cannot without invalidating the signature.
 *
 * Deliberately stateless. A Redis entry per rendered form would put a write on
 * every product page view of every store, and the signature already gives the
 * two properties that matter: authenticity and an expiry.
 */

const VERSION = 'v1';
const TOKEN_TTL_SECONDS = 30 * 60;

interface TokenPayload {
  readonly shop: string;
  readonly formId: string;
  readonly issuedAt: number;
  readonly nonce: string;
}

function sign(body: string): string {
  return createHmac('sha256', config.security.sessionSecret).update(body).digest('base64url');
}

/**
 * Issues a token for a form render.
 *
 * The nonce makes every token distinct even when two shoppers load the same
 * form in the same second, which keeps the value from being a useful cache key
 * or a cross-visitor correlator.
 */
export function issueFormToken(shop: string, formId: string): string {
  const payload: TokenPayload = {
    shop,
    formId,
    issuedAt: Math.floor(Date.now() / 1_000),
    nonce: randomBytes(9).toString('base64url'),
  };

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${VERSION}.${body}.${sign(body)}`;
}

export interface FormTokenVerification {
  readonly valid: boolean;
  readonly reason: 'malformed' | 'bad_signature' | 'expired' | 'shop_mismatch' | null;
  readonly payload: TokenPayload | null;
}

/**
 * Verifies a token and returns its payload.
 *
 * The shop is checked as well as the signature: every shop's tokens are signed
 * with the same application secret, so without this a token minted on one store
 * would be accepted on another.
 */
export function verifyFormToken(token: string, expectedShop: string): FormTokenVerification {
  const parts = token.split('.');

  if (parts.length !== 3 || parts[0] !== VERSION) {
    return { valid: false, reason: 'malformed', payload: null };
  }

  const [, body, signature] = parts as [string, string, string];
  const expected = sign(body);

  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');

  // A length mismatch means it cannot match; comparing different lengths would
  // throw, and short-circuiting on length leaks nothing an attacker cannot see.
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { valid: false, reason: 'bad_signature', payload: null };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return { valid: false, reason: 'malformed', payload: null };
  }

  if (payload.shop !== expectedShop) {
    return { valid: false, reason: 'shop_mismatch', payload: null };
  }

  const ageSeconds = Math.floor(Date.now() / 1_000) - payload.issuedAt;

  // A negative age means the server clock moved backwards, not that the token
  // is from the future — treat it as fresh rather than rejecting a valid order.
  if (ageSeconds > TOKEN_TTL_SECONDS) {
    return { valid: false, reason: 'expired', payload: null };
  }

  return { valid: true, reason: null, payload };
}

/** Seconds since the token was issued. The trustworthy fill-duration signal. */
export function tokenAgeSeconds(payload: TokenPayload): number {
  return Math.max(0, Math.floor(Date.now() / 1_000) - payload.issuedAt);
}

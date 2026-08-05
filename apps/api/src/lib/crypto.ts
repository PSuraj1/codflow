import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import { config } from '../config/env';
import { InternalError } from './errors';

/**
 * Symmetric encryption for secrets held at rest.
 *
 * Google refresh tokens, pixel Conversions API tokens and OTP provider
 * credentials are all long-lived third-party secrets. A database dump alone
 * must not be enough to use them, so they are encrypted with AES-256-GCM
 * before they reach Postgres and decrypted only at the point of use.
 *
 * GCM rather than CBC: it authenticates the ciphertext, so tampering is
 * detected on decrypt instead of silently producing garbage plaintext.
 *
 * Serialized format (all base64url, dot-separated):
 *
 *     v1.<iv>.<authTag>.<ciphertext>
 *
 * The version prefix exists so a future key rotation or algorithm change can be
 * rolled out by reading both formats and writing only the new one.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — the GCM standard nonce size.
const AUTH_TAG_LENGTH = 16;
const VERSION = 'v1';

/** Encrypts a UTF-8 string. Returns the serialized envelope described above. */
export function encrypt(plaintext: string): string {
  // A fresh random IV per encryption is mandatory for GCM: reusing an IV with
  // the same key destroys confidentiality and allows forgery.
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, config.security.encryptionKey, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a value produced by {@link encrypt}.
 *
 * Throws if the envelope is malformed or the auth tag does not verify — the
 * latter means the ciphertext was altered or the key changed. Callers that can
 * tolerate a bad value (for example, showing "reconnect your Google account")
 * should use {@link tryDecrypt} instead.
 */
export function decrypt(payload: string): string {
  const parts = payload.split('.');

  if (parts.length !== 4) {
    throw new InternalError('Malformed ciphertext envelope');
  }

  const [version, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string];

  if (version !== VERSION) {
    throw new InternalError(`Unsupported ciphertext version: ${version}`);
  }

  const iv = Buffer.from(ivB64, 'base64url');
  const authTag = Buffer.from(authTagB64, 'base64url');
  const ciphertext = Buffer.from(ciphertextB64, 'base64url');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new InternalError('Malformed ciphertext envelope');
  }

  const decipher = createDecipheriv(ALGORITHM, config.security.encryptionKey, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (cause) {
    // `final()` throws when the auth tag does not match.
    throw new InternalError('Ciphertext failed authentication — wrong key or tampered data', {
      cause,
    });
  }
}

/** Decrypt without throwing. Returns null when the value cannot be recovered. */
export function tryDecrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/**
 * Keyed digest for values that must be searchable but never readable —
 * primarily OTP codes, which are compared but never displayed.
 *
 * HMAC rather than a plain hash so an attacker with the database cannot brute
 * force the small OTP keyspace offline without also holding the key.
 */
export function hmacDigest(value: string): string {
  return createHmac('sha256', config.security.encryptionKey).update(value).digest('base64url');
}

/**
 * Constant-time comparison. Use for any secret comparison (OTP codes, HMAC
 * signatures) so response timing does not reveal how much of the value matched.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing digests of equal size keeps the operation constant-time.
  if (bufferA.length !== bufferB.length) {
    const digestA = createHash('sha256').update(bufferA).digest();
    const digestB = createHash('sha256').update(bufferB).digest();
    timingSafeEqual(digestA, digestB);
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Non-reversible digest used for grouping, not for secrecy — for example
 * `CodOrder.addressHash`, which powers duplicate-address fraud checks.
 */
export function stableHash(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

/** URL-safe random token, e.g. for storefront form nonces. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

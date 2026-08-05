import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { createLogger } from '../../lib/logger';
import { clientIp } from '../../lib/http';
import { toError } from '../../lib/errors';
import * as repository from './repository';

const log = createLogger('audit');

/**
 * Audit trail.
 *
 * Records who changed what, which Shopify requires for apps that hold merchant
 * data and which is the only way to answer "the COD form stopped working and
 * nobody touched it" honestly.
 *
 * Two properties matter more than completeness:
 *
 *  1. **Writing an audit row must never fail the operation it describes.** A
 *     merchant should not be blocked from disabling COD because the audit
 *     insert deadlocked. Failures are logged and swallowed.
 *  2. **Audit rows must not become a second copy of the data they protect.**
 *     Snapshots are redacted before they are written, so a settings change does
 *     not persist an OTP provider's auth key into a table that is deliberately
 *     kept forever.
 */

/** Actions are `entity.verb`, past tense. Grep-able and stable across releases. */
export const AuditAction = {
  APP_INSTALLED: 'app.installed',
  APP_REINSTALLED: 'app.reinstalled',
  APP_UNINSTALLED: 'app.uninstalled',
  SCOPES_UPDATED: 'app.scopes_updated',
  SESSION_EXCHANGED: 'auth.session_exchanged',
  SHOP_REDACTED: 'compliance.shop_redacted',
  CUSTOMER_REDACTED: 'compliance.customer_redacted',
  CUSTOMER_DATA_REQUESTED: 'compliance.customer_data_requested',
  RETENTION_ENFORCED: 'compliance.retention_enforced',
  SETTINGS_UPDATED: 'settings.updated',
  SETTINGS_EXPORTED: 'settings.exported',
  SETTINGS_IMPORTED: 'settings.imported',
  BUMP_CREATED: 'upsell.bump_created',
  BUMP_UPDATED: 'upsell.bump_updated',
  BUMP_DELETED: 'upsell.bump_deleted',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditActor = {
  MERCHANT: 'merchant',
  SYSTEM: 'system',
  SHOPIFY: 'shopify',
  CRON: 'cron',
} as const;

export type AuditActor = (typeof AuditActor)[keyof typeof AuditActor];

/**
 * Keys stripped from any snapshot before it is written.
 *
 * Matched case-insensitively against the key name, and applied at every depth.
 * The list intentionally includes broad substrings — `token`, `secret` — so a
 * column added in a later phase is redacted by default rather than by
 * remembering to update this file.
 */
const REDACTED_KEY_PATTERNS = [
  'token',
  'secret',
  'password',
  'apikey',
  'api_key',
  'authkey',
  'auth_key',
  'accesstoken',
  'refreshtoken',
  'codehash',
  'serviceaccount',
  'enc',
];

const REDACTED = '[redacted]';
const MAX_SNAPSHOT_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACTED_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Deep-redacts a snapshot and makes it JSON-safe.
 *
 * Prisma hands back `Decimal` and `Date` instances, which `JSON.stringify`
 * would render inconsistently (a Decimal becomes an object, a Date a string).
 * Normalizing here means an audit diff of two amounts compares like with like.
 */
function sanitize(value: unknown, depth = 0): Prisma.InputJsonValue {
  if (depth > MAX_SNAPSHOT_DEPTH) return REDACTED;
  if (value === null || value === undefined) return null as unknown as Prisma.InputJsonValue;

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();

  if (Array.isArray(value)) {
    return value.map((entry) => sanitize(entry, depth + 1));
  }

  if (typeof value === 'object') {
    // Prisma Decimal and anything else with a meaningful toString.
    const maybeDecimal = value as { toFixed?: unknown; toString: () => string };
    if (typeof maybeDecimal.toFixed === 'function') return maybeDecimal.toString();

    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTED : sanitize(entry, depth + 1);
    }
    return result;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // Functions, symbols — never legitimate in a snapshot.
  return REDACTED;
}

export interface RecordAuditInput {
  shopId: string | null;
  action: AuditAction | string;
  entity?: string;
  entityId?: string | null;
  actor?: AuditActor;
  actorId?: string | null;
  actorEmail?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Writes an audit row. Never throws. */
export async function record(input: RecordAuditInput): Promise<void> {
  try {
    await repository.insert({
      shopId: input.shopId,
      action: input.action,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      actor: input.actor ?? AuditActor.SYSTEM,
      actorId: input.actorId ?? null,
      actorEmail: input.actorEmail ?? null,
      before: input.before === undefined ? undefined : sanitize(input.before),
      after: input.after === undefined ? undefined : sanitize(input.after),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
  } catch (error) {
    log.error({ err: toError(error), action: input.action }, 'Failed to write audit log');
  }
}

/**
 * Records an action attributed to the signed-in merchant.
 *
 * Pulls actor, IP and user agent off the request so controllers do not repeat
 * that extraction — and so they cannot forget the parts that make the row
 * useful during an incident.
 */
export async function recordForRequest(
  req: Request,
  input: Omit<RecordAuditInput, 'shopId' | 'actor' | 'actorId' | 'ipAddress' | 'userAgent'>,
): Promise<void> {
  await record({
    ...input,
    shopId: req.auth?.shopId ?? null,
    actor: AuditActor.MERCHANT,
    actorId: req.auth?.userId ?? null,
    ipAddress: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
  });
}

export { sanitize as sanitizeAuditSnapshot };

import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

/** Audit persistence. Insert-only — audit rows are never updated or deleted. */

export interface AuditInsert {
  shopId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  actor: string;
  actorId: string | null;
  actorEmail: string | null;
  before: Prisma.InputJsonValue | undefined;
  after: Prisma.InputJsonValue | undefined;
  ipAddress: string | null;
  userAgent: string | null;
}

export function insert(entry: AuditInsert): Promise<{ id: string }> {
  return prisma.auditLog.create({
    data: {
      shopId: entry.shopId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      actor: entry.actor,
      actorId: entry.actorId,
      actorEmail: entry.actorEmail,
      ...(entry.before !== undefined ? { before: entry.before } : {}),
      ...(entry.after !== undefined ? { after: entry.after } : {}),
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
    },
    select: { id: true },
  });
}

export interface AuditQuery {
  shopId: string;
  action?: string;
  entity?: string;
  entityId?: string;
  limit: number;
  cursor?: string;
}

export function list(query: AuditQuery) {
  return prisma.auditLog.findMany({
    where: {
      shopId: query.shopId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    // Over-fetch by one to determine `hasMore` without a second count query.
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
}

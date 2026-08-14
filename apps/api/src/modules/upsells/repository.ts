import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

/** Order bump persistence. The only layer here that touches Prisma. */

const FIELDS = {
  id: true,
  title: true,
  description: true,
  price: true,
  isEnabled: true,
  position: true,
} as const;

export function list(shopId: string) {
  return prisma.orderBump.findMany({
    where: { shopId },
    select: FIELDS,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Only what the storefront may render, and only what is switched on. */
export function listEnabled(shopId: string) {
  return prisma.orderBump.findMany({
    where: { shopId, isEnabled: true },
    select: { id: true, title: true, description: true, price: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * The bumps a submission claimed, re-read from the database.
 *
 * Scoped to the shop and to `isEnabled`, which is what makes it safe to accept
 * ids from a browser: a shopper cannot name another shop's bump, or one the
 * merchant has switched off, and the price charged is always the stored one.
 */
export function findSelectable(shopId: string, ids: readonly string[]) {
  return prisma.orderBump.findMany({
    where: { shopId, isEnabled: true, id: { in: [...ids] } },
    select: { id: true, title: true, price: true },
  });
}

export function findById(shopId: string, id: string) {
  return prisma.orderBump.findFirst({ where: { shopId, id }, select: FIELDS });
}

export function count(shopId: string) {
  return prisma.orderBump.count({ where: { shopId } });
}

export function create(shopId: string, data: Omit<Prisma.OrderBumpCreateInput, 'shop'>) {
  return prisma.orderBump.create({ data: { ...data, shopId } as never, select: FIELDS });
}

export function update(shopId: string, id: string, data: Prisma.OrderBumpUpdateInput) {
  return prisma.orderBump.updateMany({ where: { shopId, id }, data }).then(() => findById(shopId, id));
}

export function remove(shopId: string, id: string) {
  return prisma.orderBump.deleteMany({ where: { shopId, id } });
}

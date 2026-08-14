import { Prisma } from '@prisma/client';
import { MAX_ORDER_BUMPS, type OrderBumpSummary, type SelectedBump } from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { invalidateTag, shopTag } from '../../lib/cache';
import * as repository from './repository';
import type { CreateOrderBumpInput, UpdateOrderBumpInput } from './dto';

const log = createLogger('upsells');

type Row = NonNullable<Awaited<ReturnType<typeof repository.findById>>>;

/** Decimal to string, never to a float. */
function toSummary(row: Row): OrderBumpSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    price: row.price.toString(),
    isEnabled: row.isEnabled,
    position: row.position,
  };
}

export async function listBumps(shopId: string): Promise<OrderBumpSummary[]> {
  return (await repository.list(shopId)).map(toSummary);
}

export async function createBump(
  shopId: string,
  shopDomain: string,
  input: CreateOrderBumpInput,
): Promise<OrderBumpSummary> {
  // Bounded because the tick boxes sit between the shopper and the submit
  // button; a form with six add-ons is a form nobody finishes.
  if ((await repository.count(shopId)) >= MAX_ORDER_BUMPS) {
    throw new ValidationError(`You can have up to ${MAX_ORDER_BUMPS} order bumps.`);
  }

  const row = await repository.create(shopId, {
    title: input.title,
    description: input.description ?? null,
    price: new Prisma.Decimal(input.price),
    isEnabled: input.isEnabled,
    position: input.position,
  } as never);

  await invalidateTag(shopTag(shopDomain));
  log.info({ shopId, bumpId: row.id }, 'Order bump created');

  return toSummary(row);
}

export async function updateBump(
  shopId: string,
  shopDomain: string,
  bumpId: string,
  input: UpdateOrderBumpInput,
): Promise<OrderBumpSummary> {
  const row = await repository.update(shopId, bumpId, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description ?? null } : {}),
    ...(input.price !== undefined ? { price: new Prisma.Decimal(input.price) } : {}),
    ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
  });

  if (!row) throw new NotFoundError('Order bump not found');

  // The storefront config embeds these, so a write that skipped the
  // invalidation would leave a shopper offered yesterday price.
  await invalidateTag(shopTag(shopDomain));

  return toSummary(row);
}

export async function deleteBump(
  shopId: string,
  shopDomain: string,
  bumpId: string,
): Promise<void> {
  const { count } = await repository.remove(shopId, bumpId);
  if (count === 0) throw new NotFoundError('Order bump not found');

  await invalidateTag(shopTag(shopDomain));
  log.info({ shopId, bumpId }, 'Order bump deleted');
}

export interface ResolvedBumps {
  readonly selected: SelectedBump[];
  readonly total: Prisma.Decimal;
}

/**
 * Turns the ids a submission claimed into priced add-ons.
 *
 * The browser sends ids and nothing else. Every price comes from the database,
 * which is the same rule the cart follows — the submission DTO has no price
 * field anywhere, and a shopper who edits the payload changes which bumps they
 * are charged for, never what they cost.
 *
 * Unknown, disabled and other shops' ids simply do not come back from the
 * query, so they are dropped rather than rejected: a merchant switching a bump
 * off while someone has the form open should not fail that shopper's order.
 */
export async function resolveSelected(
  shopId: string,
  ids: readonly string[],
): Promise<ResolvedBumps> {
  if (ids.length === 0) return { selected: [], total: new Prisma.Decimal(0) };

  // De-duplicated: a payload naming the same bump twice must not charge twice.
  const rows = await repository.findSelectable(shopId, [...new Set(ids)]);

  const selected = rows.map((row) => ({
    id: row.id,
    title: row.title,
    price: row.price.toString(),
  }));

  const total = rows.reduce((sum, row) => sum.add(row.price), new Prisma.Decimal(0));

  return { selected, total };
}

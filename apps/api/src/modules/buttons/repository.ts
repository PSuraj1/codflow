import type { ButtonConfig, ButtonPlacement, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

/**
 * Button persistence.
 *
 * Small on purpose. The only interesting decision is that the write is an
 * upsert keyed on `[shopId, placement]`: a shop has rows for the four
 * placements seeded at install and none for the rest, so a merchant enabling
 * COD on their home page is creating a row, not editing one.
 */

export function listButtons(shopId: string): Promise<ButtonConfig[]> {
  return prisma.buttonConfig.findMany({ where: { shopId } });
}

export function findButton(
  shopId: string,
  placement: ButtonPlacement,
): Promise<ButtonConfig | null> {
  return prisma.buttonConfig.findUnique({ where: { shopId_placement: { shopId, placement } } });
}

/**
 * Writes one placement's complete configuration.
 *
 * `record` is the full merged set rather than the merchant's patch, and the
 * same object serves both branches. That is what keeps a partial edit from
 * changing something the merchant did not touch: on the create branch the
 * unmentioned columns would otherwise fall back to the schema defaults, and
 * `isEnabled` defaults to `true` there — so saving a colour on a placement with
 * no row would switch that placement on.
 */
export function upsertButton(
  shopId: string,
  placement: ButtonPlacement,
  record: Omit<Prisma.ButtonConfigUncheckedCreateInput, 'id' | 'shopId' | 'placement'>,
): Promise<ButtonConfig> {
  return prisma.buttonConfig.upsert({
    where: { shopId_placement: { shopId, placement } },
    update: record,
    create: { shopId, placement, ...record },
  });
}

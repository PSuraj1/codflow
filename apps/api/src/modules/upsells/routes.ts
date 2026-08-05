import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { CreateOrderBumpSchema, OrderBumpParamSchema, UpdateOrderBumpSchema } from './dto';
import { createBump, deleteBump, listBumps, updateBump } from './controller';

/**
 * Upsell routes, mounted under `/api/admin/upsells`.
 *
 * Only order bumps today. The 1-click offer sequence and the exit-intent
 * downsell on the Upsells screen are not built — they need an offer-state
 * machine and exit detection, neither of which is a variation on this.
 */
export const upsellsRouter: Router = Router();

upsellsRouter.get('/bumps', listBumps);

upsellsRouter.post('/bumps', validate({ body: CreateOrderBumpSchema }), createBump);

upsellsRouter.patch(
  '/bumps/:bumpId',
  validate({ params: OrderBumpParamSchema, body: UpdateOrderBumpSchema }),
  updateBump,
);

upsellsRouter.delete('/bumps/:bumpId', validate({ params: OrderBumpParamSchema }), deleteBump);

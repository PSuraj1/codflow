import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { PlacementParamSchema, UpdateButtonSchema } from './dto';
import { list, update } from './controller';

/**
 * Button routes, mounted under `/api/admin/buttons`.
 *
 * Addressed by placement rather than by id: a shop has at most one button per
 * placement, the merchant picks one from a fixed list, and a route keyed on a
 * cuid would make the customizer look up an id for a row that may not exist yet.
 */
export const buttonsRouter: Router = Router();

buttonsRouter.get('/', list);

buttonsRouter.patch(
  '/:placement',
  validate({ params: PlacementParamSchema, body: UpdateButtonSchema }),
  update,
);

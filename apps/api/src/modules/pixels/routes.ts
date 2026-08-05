import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import {
  CreatePixelSchema,
  EventsQuerySchema,
  PixelIdParamSchema,
  TestEventSchema,
  UpdatePixelSchema,
} from './dto';
import { create, events, list, remove, test, update } from './controller';

/**
 * Pixel routes, mounted under `/api/admin/pixels`.
 *
 * `/events` is declared before the parameterised routes so it is not captured
 * as an id — Express matches in registration order, and relying on a cuid
 * validation failure to route would produce a confusing 422 instead of a list.
 */
export const pixelsRouter: Router = Router();

pixelsRouter.get('/events', validate({ query: EventsQuerySchema }), events);

pixelsRouter.get('/', list);
pixelsRouter.post('/', validate({ body: CreatePixelSchema }), create);

pixelsRouter.patch(
  '/:id',
  validate({ params: PixelIdParamSchema, body: UpdatePixelSchema }),
  update,
);

pixelsRouter.delete('/:id', validate({ params: PixelIdParamSchema }), remove);

pixelsRouter.post(
  '/:id/test',
  validate({ params: PixelIdParamSchema, body: TestEventSchema }),
  test,
);

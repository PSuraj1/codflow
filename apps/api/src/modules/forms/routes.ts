import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import {
  CreateFormSchema,
  FormIdParamSchema,
  ReplaceFieldsSchema,
  UpdateFormSchema,
} from './dto';
import { create, duplicate, getOne, list, remove, replaceFields, update } from './controller';

/**
 * Form builder routes, mounted under `/api/admin/forms`.
 *
 * Fields are a sub-resource with their own PUT rather than part of the form's
 * PATCH. That separation matters for a drag-and-drop builder: rearranging
 * fields and editing the form's copy are different operations with different
 * validation and very different audit trails, and merging them would mean every
 * heading edit re-validated and rewrote the entire field list.
 */
export const formsRouter: Router = Router();

formsRouter.get('/', list);
formsRouter.post('/', validate({ body: CreateFormSchema }), create);

formsRouter.get('/:formId', validate({ params: FormIdParamSchema }), getOne);

formsRouter.patch(
  '/:formId',
  validate({ params: FormIdParamSchema, body: UpdateFormSchema }),
  update,
);

formsRouter.put(
  '/:formId/fields',
  validate({ params: FormIdParamSchema, body: ReplaceFieldsSchema }),
  replaceFields,
);

formsRouter.post('/:formId/duplicate', validate({ params: FormIdParamSchema }), duplicate);

formsRouter.delete('/:formId', validate({ params: FormIdParamSchema }), remove);

import type { NextFunction, Request, Response } from 'express';
import type { Plan } from '@codflow/shared';
import { created, noContent, ok } from '../../lib/http';
import { InternalError } from '../../lib/errors';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as shopRepository from '../shop/repository';
import * as service from './service';
import type { CreateFormInput, ReplaceFieldsInput, UpdateFormInput } from './dto';

/**
 * Form builder HTTP surface.
 *
 * Every mutation writes an audit row, because a form is the merchant's
 * conversion path: when COD orders stop arriving, the first question is what
 * changed on the form and when. The `before`/`after` snapshots make that
 * answerable without guesswork.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/**
 * The shop's plan, for limit enforcement.
 *
 * Read per request rather than cached on the session: a merchant who upgrades
 * mid-session should be able to use what they just paid for without signing out
 * and back in.
 */
async function currentPlan(shopId: string): Promise<Plan> {
  return (await shopRepository.findPlan(shopId)) as Plan;
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.listForms(auth.shopId));
  } catch (error) {
    next(error);
  }
}

export async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.getForm(auth.shopId, req.params.formId as string));
  } catch (error) {
    next(error);
  }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as CreateFormInput;

    const form = await service.createForm(auth.shopId, await currentPlan(auth.shopId), input);

    await audit.recordForRequest(req, {
      action: 'form.created',
      entity: 'FormConfig',
      entityId: form.id,
      after: { name: form.name, fieldCount: form.fields.length },
    });

    created(res, form);
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const formId = req.params.formId as string;
    const input = req.body as UpdateFormInput;

    const before = await service.getForm(auth.shopId, formId);
    const after = await service.updateForm(auth.shopId, auth.shopDomain, formId, input);

    await audit.recordForRequest(req, {
      action: 'form.updated',
      entity: 'FormConfig',
      entityId: formId,
      // Settings only — the field list has its own action, and including it
      // here would make every copy change produce a huge audit row.
      before: { ...before, fields: undefined },
      after: { ...after, fields: undefined },
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

export async function replaceFields(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const formId = req.params.formId as string;
    const input = req.body as ReplaceFieldsInput;

    const before = await service.getForm(auth.shopId, formId);
    const after = await service.replaceFields(auth.shopId, auth.shopDomain, formId, input);

    await audit.recordForRequest(req, {
      action: 'form.fields_replaced',
      entity: 'FormConfig',
      entityId: formId,
      // Keys and order only. Storing every label and validation rule on every
      // drag would bloat a table that is never deleted, and the arrangement is
      // what an incident investigation actually needs.
      before: { fields: before.fields.map((field) => field.key) },
      after: { fields: after.fields.map((field) => field.key) },
    });

    ok(res, after);
  } catch (error) {
    next(error);
  }
}

export async function duplicate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const formId = req.params.formId as string;

    const copy = await service.duplicateForm(auth.shopId, await currentPlan(auth.shopId), formId);

    await audit.recordForRequest(req, {
      action: 'form.duplicated',
      entity: 'FormConfig',
      entityId: copy.id,
      after: { sourceId: formId, name: copy.name },
    });

    created(res, copy);
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const formId = req.params.formId as string;

    const before = await service.getForm(auth.shopId, formId);
    await service.deleteForm(auth.shopId, auth.shopDomain, formId);

    await audit.recordForRequest(req, {
      action: 'form.deleted',
      entity: 'FormConfig',
      entityId: formId,
      before: { name: before.name, fieldCount: before.fields.length },
    });

    noContent(res);
  } catch (error) {
    next(error);
  }
}

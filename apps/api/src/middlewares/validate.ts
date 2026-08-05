import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import { ValidationError } from '../lib/errors';

/**
 * Request validation.
 *
 * Every value that arrives from outside the process is parsed by a Zod schema
 * before a controller sees it, and the *parsed* value replaces the raw one.
 * That second half is what makes this worth doing: `req.query.limit` is a
 * string until the schema coerces it, and code that reads the raw value is one
 * refactor away from comparing a string to a number.
 *
 * Schemas live in each module's `dto.ts`, so the module owns its own contract.
 */

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  headers?: ZodType;
}

/**
 * Flattens a ZodError into `{ "address.city": ["Required"] }`.
 *
 * The admin renders these directly against Polaris form fields, so the key must
 * be the dotted path the client used, not Zod's array-of-segments form.
 */
function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_';
    (result[path] ??= []).push(issue.message);
  }

  return result;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: Record<string, Record<string, string[]>> = {};

    if (schemas.params) {
      const parsed = schemas.params.safeParse(req.params);
      if (parsed.success) {
        Object.assign(req.params, parsed.data);
      } else {
        errors.params = fieldErrors(parsed.error);
      }
    }

    if (schemas.query) {
      const parsed = schemas.query.safeParse(req.query);
      if (parsed.success) {
        // Express 5 defines `req.query` as a getter, so assigning to it throws.
        // Redefining the property is the supported way to hand a controller the
        // coerced object instead of the raw string map.
        Object.defineProperty(req, 'query', {
          value: parsed.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        errors.query = fieldErrors(parsed.error);
      }
    }

    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (parsed.success) {
        req.body = parsed.data;
      } else {
        errors.body = fieldErrors(parsed.error);
      }
    }

    if (schemas.headers) {
      const parsed = schemas.headers.safeParse(req.headers);
      if (!parsed.success) {
        errors.headers = fieldErrors(parsed.error);
      }
    }

    if (Object.keys(errors).length > 0) {
      // One error covering every section, so a form with problems in both the
      // body and the query does not require two round trips to fix.
      next(new ValidationError('Request validation failed', { details: errors }));
      return;
    }

    next();
  };
}

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { listStuck, pushStatus, retryPush, verifyOrder } from './adminController';

/**
 * Merchant order routes, mounted under `/api/admin/orders`.
 *
 * Scoped to push recovery for now. Full order management — search, filters,
 * bulk actions, exports — is its own phase; this is the subset a merchant needs
 * the day a push fails, which is the one order problem they cannot work around
 * themselves.
 */
export const ordersAdminRouter: Router = Router();

/** References are `CF-XXXXXXXX` over an unambiguous alphabet. */
const ReferenceParamSchema = z.object({
  reference: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[A-Z]{2}-[A-Z0-9]+$/, 'Not a valid order reference'),
});

/**
 * One page of one group.
 *
 * The limit is capped well below what the screen could render: this list is
 * read while something is wrong, when the table is at its largest, and an
 * unbounded page would let one request scan an arbitrary slice of it.
 */
export const StuckQuerySchema = z.object({
  group: z.enum(['failing', 'held', 'waiting']).default('failing'),
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type StuckQueryInput = z.infer<typeof StuckQuerySchema>;

// Declared before the parameterised routes so `/stuck` is not captured as a
// reference. Express 5 matches in registration order, and `stuck` would fail
// the reference pattern anyway — but relying on a validation error to route is
// fragile and produces a confusing 422 instead of a list.
ordersAdminRouter.get('/stuck', validate({ query: StuckQuerySchema }), listStuck);

ordersAdminRouter.get(
  '/:reference/push-status',
  validate({ params: ReferenceParamSchema }),
  pushStatus,
);

ordersAdminRouter.post(
  '/:reference/retry-push',
  validate({ params: ReferenceParamSchema }),
  retryPush,
);

ordersAdminRouter.post(
  '/:reference/verify',
  validate({ params: ReferenceParamSchema }),
  verifyOrder,
);

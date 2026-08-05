import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import {
  AddBlockListEntrySchema,
  BlockListQuerySchema,
  BulkBlockListSchema,
  CreateFraudRuleSchema,
  IdParamSchema,
  ReferenceParamSchema,
  ReviewAssessmentSchema,
  UpdateFraudRuleSchema,
  UpdateFraudSettingsSchema,
} from './dto';
import {
  addBlockListEntry,
  bulkBlockList,
  createRule,
  deleteRule,
  getAssessment,
  getSettings,
  listBlockList,
  listRules,
  removeBlockListEntry,
  rescan,
  reviewAssessment,
  updateRule,
  updateSettings,
} from './controller';

/**
 * Fraud routes, mounted under `/api/admin/fraud`.
 *
 * Three groups with different shapes: shop-wide settings, the block list and
 * rules as collections, and per-order assessments addressed by the reference
 * the merchant actually sees.
 */
export const fraudRouter: Router = Router();

// ---- Settings
fraudRouter.get('/settings', getSettings);
fraudRouter.patch('/settings', validate({ body: UpdateFraudSettingsSchema }), updateSettings);

// ---- Block list
fraudRouter.get('/blocklist', validate({ query: BlockListQuerySchema }), listBlockList);
fraudRouter.post('/blocklist', validate({ body: AddBlockListEntrySchema }), addBlockListEntry);
fraudRouter.delete('/blocklist/:id', validate({ params: IdParamSchema }), removeBlockListEntry);

// Declared after the parameterised delete but matched independently — `bulk`
// is a PUT, so it cannot collide with the id routes above.
fraudRouter.put('/blocklist/bulk', validate({ body: BulkBlockListSchema }), bulkBlockList);

// ---- Rules
fraudRouter.get('/rules', listRules);
fraudRouter.post('/rules', validate({ body: CreateFraudRuleSchema }), createRule);
fraudRouter.patch('/rules/:id', validate({ params: IdParamSchema, body: UpdateFraudRuleSchema }), updateRule);
fraudRouter.delete('/rules/:id', validate({ params: IdParamSchema }), deleteRule);

// ---- Per-order assessments
fraudRouter.get('/orders/:reference', validate({ params: ReferenceParamSchema }), getAssessment);

fraudRouter.post(
  '/orders/:reference/review',
  validate({ params: ReferenceParamSchema, body: ReviewAssessmentSchema }),
  reviewAssessment,
);

fraudRouter.post('/orders/:reference/rescan', validate({ params: ReferenceParamSchema }), rescan);

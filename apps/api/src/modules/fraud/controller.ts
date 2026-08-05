import type { NextFunction, Request, Response } from 'express';
import { BlockListScope, BlockListType, Prisma, RiskAction } from '@prisma/client';
import { created, noContent, ok } from '../../lib/http';
import { InternalError, NotFoundError } from '../../lib/errors';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as orderRepository from '../orders/repository';
import * as shopRepository from '../shop/repository';
import * as service from './service';
import * as repository from './repository';
import type {
  AddBlockListEntryInput,
  BulkBlockListInput,
  BlockListQueryInput,
  CreateFraudRuleInput,
  ReviewAssessmentInput,
  UpdateFraudRuleInput,
  UpdateFraudSettingsInput,
} from './dto';

/**
 * Fraud admin surface.
 *
 * Every mutation is audited. A merchant investigating "why did we stop getting
 * orders from Delhi" needs to see that someone raised a threshold or added a
 * postal code to the block list, and when.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.getSettings(auth.shopId));
  } catch (error) {
    next(error);
  }
}

export async function updateSettings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpdateFraudSettingsInput;

    const before = await service.getSettings(auth.shopId);
    const after = await service.updateSettings(
      auth.shopId,
      input as unknown as Prisma.FraudSettingsUpdateInput,
    );

    await audit.recordForRequest(req, {
      action: 'fraud.settings_updated',
      entity: 'FraudSettings',
      before,
      after,
    });

    // Orders already waiting are re-scored against the new configuration —
    // otherwise a merchant lowering a threshold would only affect future
    // orders, while their intent is to act on the backlog in front of them.
    const rescan = await service.rescanPending(auth.shopId, auth.shopDomain);

    ok(res, { ...after, rescanQueued: rescan.queued });
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Block list
// ---------------------------------------------------------------------------

export async function listBlockList(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const query = req.query as unknown as BlockListQueryInput;

    ok(
      res,
      await service.listBlockList(
        auth.shopId,
        {
          ...(query.type ? { type: query.type as BlockListType } : {}),
          ...(query.scope ? { scope: query.scope as BlockListScope } : {}),
          ...(query.search ? { search: query.search } : {}),
        },
        query.limit,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function addBlockListEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as AddBlockListEntryInput;

    const entry = await service.addBlockListEntry(auth.shopId, {
      type: input.type as BlockListType,
      scope: input.scope as BlockListScope,
      value: input.value,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
    });

    await audit.recordForRequest(req, {
      action: 'fraud.blocklist_added',
      entity: 'BlockListEntry',
      entityId: entry.id,
      // The normalized value is recorded, not the raw input: it is what the
      // detectors match on, so it is what an investigation needs.
      after: { type: entry.type, scope: entry.scope, value: entry.value },
    });

    // The whole point of adding a block list entry is usually the order sitting
    // in review right now, not the next one.
    const rescan = await service.rescanPending(auth.shopId, auth.shopDomain);

    created(res, { ...entry, rescanQueued: rescan.queued });
  } catch (error) {
    next(error);
  }
}

/**
 * `PUT /api/admin/fraud/blocklist/bulk`
 *
 * The whole of one list at once. Audited with counts rather than the values —
 * a merchant pasting ten thousand phone numbers should not write ten thousand
 * numbers into a table that is never deleted, and "removed 400, added 3" is
 * what an investigation actually needs.
 */
export async function bulkBlockList(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as BulkBlockListInput;

    const result = await service.replaceBlockList(
      auth.shopId,
      input.type as BlockListType,
      input.scope as BlockListScope,
      input.values,
    );

    await audit.recordForRequest(req, {
      action: 'fraud.blocklist_replaced',
      entity: 'BlockListEntry',
      after: {
        type: input.type,
        scope: input.scope,
        total: result.total,
        added: result.added,
        removed: result.removed,
      },
    });

    // Same reasoning as adding one entry: the order sitting in review right now
    // is usually the reason the merchant is editing this at all.
    const rescan = await service.rescanPending(auth.shopId, auth.shopDomain);

    ok(res, { ...result, rescanQueued: rescan.queued });
  } catch (error) {
    next(error);
  }
}

export async function removeBlockListEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const id = req.params.id as string;

    await service.removeBlockListEntry(auth.shopId, id);

    await audit.recordForRequest(req, {
      action: 'fraud.blocklist_removed',
      entity: 'BlockListEntry',
      entityId: id,
    });

    noContent(res);
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function listRules(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.listRules(auth.shopId));
  } catch (error) {
    next(error);
  }
}

export async function createRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as CreateFraudRuleInput;

    const rule = await repository.createRule(auth.shopId, {
      name: input.name,
      isEnabled: input.isEnabled,
      priority: input.priority,
      conditions: input.conditions as unknown as Prisma.InputJsonValue,
      scoreDelta: input.scoreDelta,
      action: (input.action ?? null) as RiskAction | null,
      reason: input.reason ?? null,
    });

    await audit.recordForRequest(req, {
      action: 'fraud.rule_created',
      entity: 'FraudRule',
      entityId: rule.id,
      after: { name: rule.name, scoreDelta: rule.scoreDelta, action: rule.action },
    });

    const rescan = await service.rescanPending(auth.shopId, auth.shopDomain);
    created(res, { ...rule, rescanQueued: rescan.queued });
  } catch (error) {
    next(error);
  }
}

export async function updateRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const id = req.params.id as string;
    const input = req.body as UpdateFraudRuleInput;

    const result = await repository.updateRule(auth.shopId, id, {
      ...input,
      ...(input.conditions
        ? { conditions: input.conditions as unknown as Prisma.InputJsonValue }
        : {}),
    } as Prisma.FraudRuleUpdateInput);

    if (result.count === 0) throw new NotFoundError('Rule not found');

    await audit.recordForRequest(req, {
      action: 'fraud.rule_updated',
      entity: 'FraudRule',
      entityId: id,
      after: input,
    });

    // Covers the release direction too: disabling a rule that was holding
    // orders in review re-scores them, and the job enqueues the push for any
    // that come back clean.
    const rescan = await service.rescanPending(auth.shopId, auth.shopDomain);

    ok(res, { id, updated: true, rescanQueued: rescan.queued });
  } catch (error) {
    next(error);
  }
}

export async function deleteRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const id = req.params.id as string;

    const removed = await repository.deleteRule(auth.shopId, id);
    if (!removed) throw new NotFoundError('Rule not found');

    await audit.recordForRequest(req, {
      action: 'fraud.rule_deleted',
      entity: 'FraudRule',
      entityId: id,
    });

    noContent(res);
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Assessments
// ---------------------------------------------------------------------------

/** `GET /api/admin/fraud/orders/:reference` — the risk breakdown for one order. */
export async function getAssessment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const reference = req.params.reference as string;

    const order = await orderRepository.findByReference(auth.shopId, reference);
    if (!order) throw new NotFoundError('Order not found');

    const assessment = await service.getLatestAssessment(auth.shopId, order.id);

    ok(res, {
      reference: order.reference,
      riskScore: order.riskScore,
      riskLevel: order.riskLevel,
      riskAction: order.riskAction,
      assessment,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /api/admin/fraud/orders/:reference/review`
 *
 * The merchant overriding the engine. Approving a held order is the common
 * case, and it is what unblocks the push — so the order is re-queued here
 * rather than waiting for something else to notice.
 */
export async function reviewAssessment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const reference = req.params.reference as string;
    const input = req.body as ReviewAssessmentInput;

    const order = await orderRepository.findByReference(auth.shopId, reference);
    if (!order) throw new NotFoundError('Order not found');

    await service.reviewAssessment(
      auth.shopId,
      order.id,
      input.decision as RiskAction,
      auth.userId,
      input.note ?? null,
    );

    await orderRepository.appendEvent(
      order.id,
      'risk.reviewed',
      `A merchant set this order to ${input.decision}.`,
      'merchant',
      { decision: input.decision, note: input.note ?? null },
    );

    await audit.recordForRequest(req, {
      action: 'fraud.assessment_reviewed',
      entity: 'CodOrder',
      entityId: order.id,
      before: { riskAction: order.riskAction },
      after: { riskAction: input.decision, note: input.note ?? null },
    });

    ok(res, { reference: order.reference, riskAction: input.decision });
  } catch (error) {
    next(error);
  }
}

/** `POST /api/admin/fraud/orders/:reference/rescan` — re-run the engine. */
export async function rescan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const reference = req.params.reference as string;

    const order = await orderRepository.findByReference(auth.shopId, reference);
    if (!order) throw new NotFoundError('Order not found');

    const shop = await shopRepository.findByDomain(auth.shopDomain);
    const outcome = await service.rescanOrder(order, shop?.domain ?? auth.shopDomain);

    await orderRepository.appendEvent(
      order.id,
      'risk.rescanned',
      `Rescanned — score ${outcome.assessment.score} (${outcome.assessment.level}).`,
      'merchant',
      { score: outcome.assessment.score, action: outcome.assessment.action },
    );

    ok(res, {
      reference: order.reference,
      score: outcome.assessment.score,
      level: outcome.assessment.level,
      action: outcome.assessment.action,
      signals: outcome.assessment.signals.filter((entry) => entry.weight !== 0),
    });
  } catch (error) {
    next(error);
  }
}

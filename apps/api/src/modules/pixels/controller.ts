import type { NextFunction, Request, Response } from 'express';
import type { PixelEventName } from '@prisma/client';
import { created, noContent, ok } from '../../lib/http';
import { InternalError } from '../../lib/errors';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as service from './service';
import type {
  CreatePixelInput,
  EventsQueryInput,
  TestEventInput,
  UpdatePixelInput,
} from './dto';

/**
 * Pixel admin surface.
 *
 * The audit entries here deliberately never carry `accessToken`. The audit
 * sanitizer would redact it anyway — `token` is one of its matched substrings —
 * but not relying on that is cheaper than discovering the one path where it
 * did not.
 */

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.listPixels(auth.shopId));
  } catch (error) {
    next(error);
  }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as CreatePixelInput;

    const pixel = await service.createPixel(auth.shopId, auth.shopDomain, {
      ...input,
      testEventCode: input.testEventCode ?? null,
      conversionId: input.conversionId ?? null,
      conversionLabel: input.conversionLabel ?? null,
      gtmContainerId: input.gtmContainerId ?? null,
      customScript: input.customScript ?? null,
      enabledEvents: input.enabledEvents as PixelEventName[],
    });

    await audit.recordForRequest(req, {
      action: 'pixel.created',
      entity: 'Pixel',
      entityId: pixel.id,
      after: { provider: pixel.provider, label: pixel.label, pixelId: pixel.pixelId },
    });

    created(res, pixel);
  } catch (error) {
    next(error);
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const id = req.params.id as string;
    const input = req.body as UpdatePixelInput;

    const pixel = await service.updatePixel(auth.shopId, auth.shopDomain, id, {
      ...input,
      ...(input.enabledEvents ? { enabledEvents: input.enabledEvents as PixelEventName[] } : {}),
    });

    await audit.recordForRequest(req, {
      action: 'pixel.updated',
      entity: 'Pixel',
      entityId: id,
      // Explicitly reconstructed rather than spreading `input`, so a token can
      // never reach the audit table even if the sanitizer changed.
      after: {
        label: pixel.label,
        isEnabled: pixel.isEnabled,
        clientSideEnabled: pixel.clientSideEnabled,
        serverSideEnabled: pixel.serverSideEnabled,
        enabledEvents: pixel.enabledEvents,
      },
    });

    ok(res, pixel);
  } catch (error) {
    next(error);
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const id = req.params.id as string;

    await service.deletePixel(auth.shopId, auth.shopDomain, id);

    await audit.recordForRequest(req, {
      action: 'pixel.deleted',
      entity: 'Pixel',
      entityId: id,
    });

    noContent(res);
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /api/admin/pixels/:id/test`
 *
 * Sends a synthetic conversion so a merchant can confirm the integration before
 * relying on it — and see the provider's own error message when it does not
 * work, rather than a generic failure.
 */
export async function test(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const id = req.params.id as string;
    const input = req.body as TestEventInput;

    const result = await service.sendTestEvent(
      auth.shopId,
      id,
      input.eventName as PixelEventName,
    );

    await audit.recordForRequest(req, {
      action: 'pixel.test_sent',
      entity: 'Pixel',
      entityId: id,
      after: { eventName: input.eventName, ok: result.ok, status: result.httpStatus },
    });

    ok(res, result);
  } catch (error) {
    next(error);
  }
}

/** `GET /api/admin/pixels/events` — recent activity, for diagnostics. */
export async function events(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const query = req.query as unknown as EventsQueryInput;

    ok(res, await service.recentEvents(auth.shopId, query.limit));
  } catch (error) {
    next(error);
  }
}

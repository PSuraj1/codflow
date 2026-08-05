import type { NextFunction, Request, Response } from 'express';
import { accepted, created, noContent, ok } from '../../lib/http';
import { BadRequestError, InternalError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { embeddedAppUrl } from '../../shopify/urls';
import type { AdminAuthContext } from '../../types/express';
import * as audit from '../audit/service';
import * as googleService from '../google/service';
import * as shopRepository from '../shop/repository';
import * as service from './service';
import type {
  BackfillInput,
  CreateSheetInput,
  GoogleCallbackInput,
  SelectSheetInput,
  UpdateMappingInput,
  UpdateSheetSettingsInput,
} from './dto';

const log = createLogger('sheets-controller');

function requireAuth(req: Request): AdminAuthContext {
  if (!req.auth) {
    throw new InternalError('Route is missing the authenticateAdmin middleware');
  }
  return req.auth;
}

/** `GET /api/admin/sheets` — everything the settings screen needs, in one call. */
export async function getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.overview(auth.shopId));
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /api/admin/sheets/connect-url`
 *
 * Returns the Google consent URL rather than redirecting to it. The caller is
 * the embedded admin, and a 302 would try to navigate the *iframe* — Google
 * sends `X-Frame-Options: DENY` on its consent screen, so that renders a blank
 * panel. Handing the URL back lets the client open it in the top frame, which
 * is the only thing that works.
 */
export function getConnectUrl(req: Request, res: Response, next: NextFunction): void {
  try {
    const auth = requireAuth(req);
    ok(res, { url: googleService.startConnect(auth.shopDomain) });
  } catch (error) {
    next(error);
  }
}

/**
 * `GET /api/google/callback` — where Google returns the merchant.
 *
 * Unauthenticated by necessity: the browser is arriving from
 * accounts.google.com with no App Bridge session. The signed `state` is the
 * only thing tying this response to a shop, which is why it is verified before
 * anything else happens.
 *
 * Ends in a redirect back into the embedded app rather than a JSON body — the
 * merchant is looking at a browser tab, not calling an API.
 */
export async function handleCallback(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as unknown as GoogleCallbackInput;

    if (!query.state) {
      throw new BadRequestError('This Google connection link is not valid.');
    }

    // Verified first: it establishes which shop this is for, and it must happen
    // before the error branch so a failure is reported inside the right shop's
    // app rather than on a bare error page.
    const shopDomain = googleService.verifyState(query.state);

    if (query.error) {
      // The merchant declined consent, or Google refused. Not an app error —
      // send them back with a flag the settings screen can explain.
      log.info({ shop: shopDomain, error: query.error }, 'Google consent was not granted');
      res.redirect(302, embeddedAppUrl(shopDomain, `/settings/sheets?google_error=${encodeURIComponent(query.error)}`));
      return;
    }

    if (!query.code) {
      throw new BadRequestError('Google did not return an authorization code.');
    }

    const shop = await shopRepository.findIdByDomain(shopDomain);

    if (!shop) {
      throw new BadRequestError('That shop is not installed.');
    }

    const account = await googleService.completeConnect(shop.id, query.code);

    await audit.record({
      shopId: shop.id,
      action: 'google.connected',
      entity: 'GoogleAccount',
      actor: audit.AuditActor.MERCHANT,
      // Email only — no tokens, and the audit sanitizer would strip them anyway.
      after: { email: account.email },
    });

    res.redirect(302, embeddedAppUrl(shopDomain, '/settings/sheets?google_connected=1'));
  } catch (error) {
    next(error);
  }
}

export async function disconnect(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);

    await googleService.disconnect(auth.shopId);

    await audit.recordForRequest(req, {
      action: 'google.disconnected',
      entity: 'GoogleAccount',
    });

    noContent(res);
  } catch (error) {
    next(error);
  }
}

export async function listSpreadsheets(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    ok(res, await service.listAvailableSpreadsheets(auth.shopId));
  } catch (error) {
    next(error);
  }
}

export async function listWorksheets(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const spreadsheetId = req.params.spreadsheetId as string;
    ok(res, await service.listWorksheets(auth.shopId, spreadsheetId));
  } catch (error) {
    next(error);
  }
}

export async function createSheet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as CreateSheetInput;

    const config = await service.createAndSelect(auth.shopId, input.title, input.worksheetName);

    await audit.recordForRequest(req, {
      action: 'sheets.spreadsheet_created',
      entity: 'SheetConfig',
      entityId: config.id,
      after: { spreadsheetId: config.spreadsheetId, name: config.spreadsheetName },
    });

    created(res, config);
  } catch (error) {
    next(error);
  }
}

export async function selectSheet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as SelectSheetInput;

    const config = await service.selectExisting(
      auth.shopId,
      input.spreadsheetId,
      input.worksheetName,
    );

    await audit.recordForRequest(req, {
      action: 'sheets.spreadsheet_selected',
      entity: 'SheetConfig',
      entityId: config.id,
      after: { spreadsheetId: config.spreadsheetId, worksheet: config.worksheetName },
    });

    ok(res, config);
  } catch (error) {
    next(error);
  }
}

export async function updateMapping(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = requireAuth(req);
    const input = req.body as UpdateMappingInput;

    const config = await service.updateMapping(auth.shopId, input);

    await audit.recordForRequest(req, {
      action: 'sheets.mapping_updated',
      entity: 'SheetConfig',
      entityId: config.id,
      // Column order only. The headers are the merchant's own text and would
      // bloat a table that is never pruned.
      after: { columns: config.columnMapping.map((column) => column.source) },
    });

    ok(res, config);
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
    const input = req.body as UpdateSheetSettingsInput;

    const config = await service.updateSettings(auth.shopId, input);

    await audit.recordForRequest(req, {
      action: 'sheets.settings_updated',
      entity: 'SheetConfig',
      entityId: config.id,
      after: input,
    });

    ok(res, config);
  } catch (error) {
    next(error);
  }
}

export async function backfill(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = requireAuth(req);
    const query = req.query as unknown as BackfillInput;

    const result = await service.backfill(auth.shopId, auth.shopDomain, query.limit);

    await audit.recordForRequest(req, {
      action: 'sheets.backfill_queued',
      entity: 'SheetConfig',
      after: result,
    });

    accepted(res, result);
  } catch (error) {
    next(error);
  }
}

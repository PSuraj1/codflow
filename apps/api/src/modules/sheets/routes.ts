import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middlewares/validate';
import { authRateLimit } from '../../middlewares/rateLimit';
import {
  BackfillSchema,
  CreateSheetSchema,
  GoogleCallbackSchema,
  SelectSheetSchema,
  UpdateMappingSchema,
  UpdateSheetSettingsSchema,
} from './dto';
import {
  backfill,
  createSheet,
  disconnect,
  getConnectUrl,
  getOverview,
  handleCallback,
  listSpreadsheets,
  listWorksheets,
  selectSheet,
  updateMapping,
  updateSettings,
} from './controller';

/**
 * Google Sheets routes.
 *
 * Split across two mount points because they have different trust levels:
 *
 *  - `/api/admin/sheets/*` — authenticated merchant operations.
 *  - `/api/google/callback` — public, because the merchant's browser arrives
 *    from accounts.google.com with no App Bridge session. Its only protection
 *    is the signed `state` parameter, verified before anything else runs.
 */
export const sheetsAdminRouter: Router = Router();

sheetsAdminRouter.get('/', getOverview);
sheetsAdminRouter.get('/connect-url', getConnectUrl);
sheetsAdminRouter.delete('/account', disconnect);

sheetsAdminRouter.get('/spreadsheets', listSpreadsheets);

sheetsAdminRouter.get(
  '/spreadsheets/:spreadsheetId/worksheets',
  validate({
    params: z.object({
      spreadsheetId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/),
    }),
  }),
  listWorksheets,
);

sheetsAdminRouter.post('/spreadsheets', validate({ body: CreateSheetSchema }), createSheet);
sheetsAdminRouter.put('/spreadsheet', validate({ body: SelectSheetSchema }), selectSheet);
sheetsAdminRouter.put('/mapping', validate({ body: UpdateMappingSchema }), updateMapping);
sheetsAdminRouter.patch('/settings', validate({ body: UpdateSheetSettingsSchema }), updateSettings);
sheetsAdminRouter.post('/backfill', validate({ query: BackfillSchema }), backfill);

/**
 * The public OAuth return path. Its URL must match `GOOGLE_REDIRECT_URI`
 * exactly — Google compares it against the registered value character for
 * character, and a trailing slash is enough to fail the exchange.
 */
export const googleCallbackRouter: Router = Router();

googleCallbackRouter.use(authRateLimit);
googleCallbackRouter.get('/callback', validate({ query: GoogleCallbackSchema }), handleCallback);

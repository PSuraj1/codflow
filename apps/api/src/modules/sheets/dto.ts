import { z } from 'zod';
import { MAX_SHEET_COLUMNS } from '@codflow/shared';

/**
 * Google Sheets request contracts.
 *
 * The mapping is the interesting one. It arrives as an ordered array — the
 * merchant's left-to-right column order — and the column letters are assigned
 * server-side from position rather than trusted from the client. Accepting a
 * client-supplied letter would let the array order and the letters disagree,
 * and the sync writes by position, so the sheet would silently not match the
 * mapping screen.
 */

/** A source key from the catalogue, or a `customFields.<key>` binding. */
const sourceKey = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^(?:[a-zA-Z][a-zA-Z0-9_]*|lineItem\.[a-zA-Z][a-zA-Z0-9_]*|customFields\.[a-zA-Z][a-zA-Z0-9_]*)$/,
    'Not a valid field source',
  );

const columnMapping = z.object({
  source: sourceKey,
  header: z.string().min(1).max(120),
});

export const UpdateMappingSchema = z.object({
  columns: z
    .array(columnMapping)
    .min(1, 'Map at least one column')
    .max(MAX_SHEET_COLUMNS, `A sheet can have at most ${MAX_SHEET_COLUMNS} mapped columns`)
    .refine(
      (columns) => new Set(columns.map((column) => column.source)).size === columns.length,
      { message: 'Each field can only be mapped to one column' },
    ),
});

export type UpdateMappingInput = z.infer<typeof UpdateMappingSchema>;

/** Spreadsheet ids are opaque Google identifiers. */
const spreadsheetId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/, 'Not a valid spreadsheet id');

export const SelectSheetSchema = z.object({
  spreadsheetId,
  /** Omitted to use the first tab. */
  worksheetName: z.string().min(1).max(100).optional(),
});

export type SelectSheetInput = z.infer<typeof SelectSheetSchema>;

export const CreateSheetSchema = z.object({
  title: z.string().min(1).max(120).default('CODkar Orders'),
  worksheetName: z.string().min(1).max(100).default('Orders'),
});

export type CreateSheetInput = z.infer<typeof CreateSheetSchema>;

/** The two layout checkboxes, plus the toggles beside them. */
export const UpdateSheetSettingsSchema = z.object({
  autoSync: z.boolean().optional(),
  includeHeaders: z.boolean().optional(),
  singleRowPerOrder: z.boolean().optional(),
  insertAtTop: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateSheetSettingsInput = z.infer<typeof UpdateSheetSettingsSchema>;

export const BackfillSchema = z.object({
  /**
   * Bounded per call. A merchant with fifty thousand historic orders should
   * backfill in batches rather than enqueue the lot in one request — Google's
   * per-minute write quota is the real constraint, and a single enormous batch
   * only makes the backlog longer, not faster.
   */
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type BackfillInput = z.infer<typeof BackfillSchema>;

/** Query on the OAuth callback Google redirects to. */
export const GoogleCallbackSchema = z.object({
  code: z.string().min(1).max(2_000).optional(),
  state: z.string().min(1).max(2_000).optional(),
  error: z.string().max(200).optional(),
});

export type GoogleCallbackInput = z.infer<typeof GoogleCallbackSchema>;

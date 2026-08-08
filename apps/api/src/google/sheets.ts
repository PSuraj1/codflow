import { createLogger } from '../lib/logger';
import { ServiceUnavailableError, toError } from '../lib/errors';
import { AppError, ErrorCode } from '../lib/errors';

const log = createLogger('google-sheets');

/**
 * Google Sheets and Drive access.
 *
 * Plain `fetch` against the REST endpoints rather than the `googleapis` client.
 * The endpoints used here are four, and they are stable; the client library
 * costs a large dependency graph at import time on every worker boot, and its
 * error objects would still need unwrapping into this app's own error types
 * before any of it were useful.
 *
 * Every call funnels through `request`, which is where the failure taxonomy
 * lives — and that taxonomy is what the sync engine's retry decisions depend
 * on. A 429 should back off; a 403 on a deleted spreadsheet should not retry at
 * all, because it will fail identically forever.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

/** Google's error shape, as far as anything here needs it. */
interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

/** Raised when the spreadsheet is gone or no longer shared with the app. */
export class SheetUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 422, ErrorCode.GOOGLE_API_ERROR, {}, true);
  }
}

/** Raised for anything transient — quota, 5xx, network. Worth retrying. */
export class SheetTransientError extends AppError {
  constructor(message: string, retryAfter?: number) {
    super(message, 503, ErrorCode.GOOGLE_API_ERROR, retryAfter ? { retryAfter } : {});
  }
}

async function request<T>(
  url: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    // DNS, TLS, socket reset. Always worth another attempt.
    throw new SheetTransientError(`Could not reach Google: ${toError(error).message}`);
  }

  if (response.ok) {
    // 204 on some Drive calls.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
  const message = body.error?.message ?? `Google returned ${response.status}`;

  // 429 and 503 are Google's rate limiter and its capacity signal. Both clear
  // on their own, so they retry with the delay Google suggests when it gives
  // one.
  if (response.status === 429 || response.status === 503) {
    const retryAfter = Number(response.headers.get('Retry-After')) || undefined;
    throw new SheetTransientError(message, retryAfter);
  }

  if (response.status >= 500) {
    throw new SheetTransientError(message);
  }

  // 404 — deleted. 403 — un-shared, or the merchant lost access to it.
  // Neither improves on retry; the merchant has to pick a different sheet.
  if (response.status === 404 || response.status === 403) {
    throw new SheetUnavailableError(message);
  }

  if (response.status === 401) {
    // The caller refreshes and retries once. Reaching here twice means the
    // refresh token itself is dead.
    throw new ServiceUnavailableError('Google rejected the access token');
  }

  throw new AppError(message, 422, ErrorCode.GOOGLE_API_ERROR);
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
  modifiedTime?: string;
}

/**
 * Lists spreadsheets this app can see.
 *
 * Under `drive.file` that means spreadsheets CODkar created, plus any the
 * merchant explicitly granted through Google's picker — not their whole Drive.
 * A merchant who expects to see every sheet they own will not, and the UI says
 * so rather than presenting an unexplained empty list.
 */
export async function listSpreadsheets(accessToken: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,webViewLink,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '100',
  });

  const body = await request<{ files: DriveFile[] }>(
    `${DRIVE_API}?${params.toString()}`,
    accessToken,
  );

  return body.files ?? [];
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export interface SpreadsheetMeta {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties: { title: string };
  sheets: Array<{
    properties: { sheetId: number; title: string; index: number };
  }>;
}

export function getSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
): Promise<SpreadsheetMeta> {
  const params = new URLSearchParams({
    fields: 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties',
  });

  return request<SpreadsheetMeta>(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?${params.toString()}`,
    accessToken,
  );
}

/** Creates a spreadsheet owned by the merchant, with one named worksheet. */
export async function createSpreadsheet(
  accessToken: string,
  title: string,
  worksheetTitle: string,
): Promise<SpreadsheetMeta> {
  return request<SpreadsheetMeta>(SHEETS_API, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: worksheetTitle } }],
    }),
  });
}

/** Adds a worksheet tab to an existing spreadsheet. */
export async function addWorksheet(
  accessToken: string,
  spreadsheetId: string,
  title: string,
): Promise<number> {
  const body = await request<{
    replies: Array<{ addSheet?: { properties: { sheetId: number } } }>;
  }>(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title } } }],
    }),
  });

  const sheetId = body.replies?.[0]?.addSheet?.properties.sheetId;

  if (sheetId === undefined) {
    throw new SheetUnavailableError('Google created the tab but returned no id for it');
  }

  return sheetId;
}

/**
 * Appends rows to the end of a worksheet.
 *
 * `INSERT_ROWS` rather than `OVERWRITE`: overwrite mode reuses the first
 * visually-empty row it finds, which silently clobbers a merchant's notes if
 * they left a gap in their sheet.
 *
 * `USER_ENTERED` rather than `RAW` so that a value like `=HYPERLINK(...)` or a
 * date is interpreted the way it would be if typed. RAW would write dates as
 * text and break every formula the merchant built on top of the sheet.
 */
export async function appendRows(
  accessToken: string,
  spreadsheetId: string,
  worksheetName: string,
  rows: string[][],
): Promise<{ updatedRange: string; updatedRows: number }> {
  const range = `${quoteSheetName(worksheetName)}!A1`;
  const params = new URLSearchParams({
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    includeValuesInResponse: 'false',
  });

  const body = await request<{
    updates: { updatedRange: string; updatedRows: number };
  }>(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ values: rows }) },
  );

  return {
    updatedRange: body.updates?.updatedRange ?? '',
    updatedRows: body.updates?.updatedRows ?? rows.length,
  };
}

/**
 * Inserts rows immediately below the header.
 *
 * Two calls, not one: Sheets has no "prepend" primitive. First
 * `insertDimension` opens blank rows and pushes everything below down, then the
 * values are written into the gap. They are not atomic — a failure between them
 * leaves blank rows in the merchant's sheet — which is precisely why appending
 * is the default and this is opt-in.
 */
export async function prependRows(
  accessToken: string,
  spreadsheetId: string,
  worksheetGid: number,
  worksheetName: string,
  rows: string[][],
  headerRow: number,
): Promise<void> {
  const startIndex = headerRow; // zero-based row after the header

  await request(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          insertDimension: {
            range: {
              sheetId: worksheetGid,
              dimension: 'ROWS',
              startIndex,
              endIndex: startIndex + rows.length,
            },
            // Blank rows rather than copies of the header's formatting.
            inheritFromBefore: false,
          },
        },
      ],
    }),
  });

  const range = `${quoteSheetName(worksheetName)}!A${startIndex + 1}`;
  const params = new URLSearchParams({ valueInputOption: 'USER_ENTERED' });

  await request(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`,
    accessToken,
    { method: 'PUT', body: JSON.stringify({ values: rows }) },
  );
}

/** Writes the header row, overwriting whatever is there. */
export async function writeHeaderRow(
  accessToken: string,
  spreadsheetId: string,
  worksheetName: string,
  headers: string[],
  headerRow: number,
): Promise<void> {
  const range = `${quoteSheetName(worksheetName)}!A${headerRow}`;
  const params = new URLSearchParams({ valueInputOption: 'RAW' });

  await request(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`,
    accessToken,
    { method: 'PUT', body: JSON.stringify({ values: [headers] }) },
  );
}

/** Reads a range, for checking whether the header row is already populated. */
export async function readRange(
  accessToken: string,
  spreadsheetId: string,
  range: string,
): Promise<string[][]> {
  const body = await request<{ values?: string[][] }>(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    accessToken,
  );

  return body.values ?? [];
}

/**
 * Quotes a worksheet name for use in an A1 range.
 *
 * A tab called `Orders 2026` or `Q1/Q2` breaks an unquoted range, and a name
 * containing an apostrophe breaks a naively quoted one — Sheets escapes those
 * by doubling. Merchants name tabs whatever they like, so this is not a corner
 * case.
 */
function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

export { quoteSheetName };

import { ApiHeader, isApiErrorResponse, type ApiErrorBody } from '@codflow/shared';
import { getSessionToken, openTop } from './appBridge';

/**
 * The admin's HTTP client.
 *
 * Every call to the CodFlow API goes through here, because three behaviours
 * have to be applied to all of them and none of them belong in a component:
 *
 *  1. **A fresh session token per request.** App Bridge tokens expire in about
 *     a minute. Capturing one at mount and reusing it means the app works for
 *     sixty seconds and then 401s on everything.
 *  2. **One retry on a stale token.** The server sets
 *     `X-Shopify-Retry-Invalid-Session-Request` when a token was valid-looking
 *     but expired in flight — a normal race, not an error worth showing.
 *     Exactly one retry: a second failure is a real problem, and retrying
 *     forever would hide it behind a spinner.
 *  3. **Re-authorization handling.** A 403 carrying
 *     `X-Shopify-API-Request-Failure-Reauthorize-Url` means the merchant must
 *     pass through consent again. That redirect has to happen in the top frame.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get code(): string {
    return this.body.code;
  }

  /** Field-level errors from a VALIDATION_FAILED response, for form binding. */
  get fieldErrors(): Record<string, string[]> | null {
    const details = this.body.details as
      | { body?: Record<string, string[]>; query?: Record<string, string[]> }
      | undefined;
    return details?.body ?? details?.query ?? null;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined>;
}

const BASE = '/api';

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `${url}?${serialized}` : url;
}

async function parseError(response: Response): Promise<ApiErrorBody> {
  try {
    const body: unknown = await response.json();
    if (isApiErrorResponse(body)) return body.error;
  } catch {
    // A gateway timeout or a proxy error page is not JSON.
  }

  return {
    code: 'INTERNAL',
    message: `Request failed with status ${response.status}`,
    requestId: response.headers.get(ApiHeader.REQUEST_ID) ?? 'unknown',
  };
}

async function execute(path: string, options: RequestOptions, isRetry: boolean): Promise<Response> {
  const token = await getSessionToken();

  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 401 && !isRetry && response.headers.get(ApiHeader.RETRY_INVALID_SESSION)) {
    // The token expired between being minted and arriving. App Bridge will hand
    // back a fresh one on the next call.
    return execute(path, options, true);
  }

  return response;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await execute(path, options, false);

  if (response.status === 403) {
    const reauthorizeUrl = response.headers.get(ApiHeader.REAUTHORIZE_URL);

    if (reauthorizeUrl) {
      // Leaves the page. Nothing after this runs, so the promise never settles
      // — which is correct: the caller has nothing to render.
      openTop(reauthorizeUrl);
      return new Promise<T>(() => undefined);
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, await parseError(response));
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json();

  if (isApiErrorResponse(body)) {
    // A 2xx with an error envelope should not happen, but treating it as
    // success would hand a component an object it cannot render.
    throw new ApiError(response.status, body.error);
  }

  return (body as { data: T }).data;
}

/**
 * Fetches a file rather than an API envelope.
 *
 * Separate from `request` because the response is a download: there is no
 * `{ data }` wrapper to unwrap, and reading it as JSON would consume the body
 * this returns. Still goes through `execute`, so it carries the session token
 * and the 401 retry — which is the whole reason a plain `<a href>` cannot be
 * used for an authenticated download.
 */
export async function download(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename: string | null }> {
  const response = await execute(path, options, false);

  if (!response.ok) {
    throw new ApiError(response.status, await parseError(response));
  }

  // `attachment; filename="codflow-settings-shop-2026-08-03.json"`
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);

  return { blob: await response.blob(), filename: match?.[1]?.trim() ?? null };
}

export const api = {
  download,

  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),

  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

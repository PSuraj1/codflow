/**
 * The wire contract between the API and its clients.
 *
 * Response shapes are plain TypeScript types, not Zod schemas: the server
 * produces them (so it does not need to validate them) and the admin only needs
 * the type. Zod appears where data actually crosses a trust boundary — request
 * bodies and query strings — which is why the pagination *query* below is a
 * schema while the pagination *envelope* is a type.
 */

/**
 * Stable, machine-readable error codes.
 *
 * This lives in the shared package rather than the API because the admin UI
 * branches on these values — a re-auth prompt, a plan upsell and a validation
 * banner are three different renders of the same HTTP 4xx. Duplicating the list
 * in both packages guarantees they drift; importing it guarantees they cannot.
 */
export const ApiErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // Domain-specific
  SHOP_NOT_INSTALLED: 'SHOP_NOT_INSTALLED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  SCOPES_CHANGED: 'SCOPES_CHANGED',
  PLAN_LIMIT_REACHED: 'PLAN_LIMIT_REACHED',
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
  WEBHOOK_INVALID: 'WEBHOOK_INVALID',
  SHOPIFY_API_ERROR: 'SHOPIFY_API_ERROR',
  GOOGLE_API_ERROR: 'GOOGLE_API_ERROR',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** Error payload. Always under an `error` key, never mixed with data. */
export interface ApiErrorBody {
  readonly code: ApiErrorCode;
  readonly message: string;
  /** Field-level detail for VALIDATION_FAILED, or context for domain errors. */
  readonly details?: unknown;
  /** Correlates the client-visible failure with the server log line. */
  readonly requestId: string;
  /** Present on RATE_LIMITED and SERVICE_UNAVAILABLE, in seconds. */
  readonly retryAfter?: number;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}

/** Success payload. Always under a `data` key, so `'error' in body` is a valid discriminator. */
export interface ApiSuccessResponse<T> {
  readonly data: T;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export function isApiErrorResponse(body: unknown): body is ApiErrorResponse {
  return typeof body === 'object' && body !== null && 'error' in body;
}

/**
 * Response headers the admin client must react to.
 *
 * `REAUTHORIZE` is Shopify's convention: when the API cannot act on the
 * merchant's behalf any more (token revoked, scopes widened since install), it
 * answers 403 with these headers and the embedded client redirects the *top*
 * frame — not the iframe — to the URL. Redirecting the iframe instead lands on
 * Shopify's `frame-ancestors` block and shows the merchant a blank panel.
 */
export const ApiHeader = {
  REQUEST_ID: 'x-codflow-request-id',
  REAUTHORIZE: 'x-shopify-api-request-failure-reauthorize',
  REAUTHORIZE_URL: 'x-shopify-api-request-failure-reauthorize-url',
  /**
   * Signals that the session token was rejected and the client should fetch a
   * fresh one and retry once. App Bridge tokens are short-lived, so a token
   * that was valid when the request left the browser can expire in flight.
   */
  RETRY_INVALID_SESSION: 'x-shopify-retry-invalid-session-request',
} as const;

/** Sort direction accepted by every list endpoint. */
export const SortDirection = { ASC: 'asc', DESC: 'desc' } as const;
export type SortDirection = (typeof SortDirection)[keyof typeof SortDirection];

/**
 * Cursor pagination envelope.
 *
 * Cursor rather than offset because COD orders arrive continuously: with
 * `LIMIT/OFFSET`, a row inserted while the merchant pages through the list
 * shifts every subsequent page and silently hides a record.
 */
export interface Paginated<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Omitted on large tables where an exact count is too expensive. */
  readonly totalCount?: number;
}

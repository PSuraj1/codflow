/**
 * Job contracts.
 *
 * Payloads are deliberately thin — an id and the minimum context needed to
 * re-read the record. A job that carried the whole order would be a snapshot
 * taken at enqueue time, and by the time a retry runs an hour later that
 * snapshot may disagree with the database: the merchant could have cancelled
 * the order, or the fraud engine could have rescored it. Re-reading on every
 * attempt means the worker always acts on current state.
 *
 * It also keeps Redis small. A queue holding full order payloads for a shop
 * with a backlog is a memory problem, and BullMQ retains completed jobs.
 */

export const QueueName = {
  ORDER_PUSH: 'order-push',
  SHEET_SYNC: 'sheet-sync',
  PIXEL_DISPATCH: 'pixel-dispatch',
  FRAUD_SCAN: 'fraud-scan',
  STATS_REBUILD: 'stats-rebuild',
  DATA_RETENTION: 'data-retention',
  AUTOMATION: 'automation',
  NOTIFICATION: 'notification',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/**
 * Pushes a confirmed COD order into Shopify.
 *
 * `shopDomain` travels with the job so the worker can load the offline session
 * without a database round trip just to resolve the tenant.
 */
export interface OrderPushJob {
  readonly codOrderId: string;
  readonly shopDomain: string;
  /** Set when a merchant retried by hand, so the audit trail can say who. */
  readonly triggeredBy?: string;
}

/** Maps a queue to the payload it carries. */
export interface JobPayloads {
  [QueueName.ORDER_PUSH]: OrderPushJob;
  [QueueName.SHEET_SYNC]: { codOrderId: string; shopDomain: string; sheetConfigId?: string };
  [QueueName.PIXEL_DISPATCH]: { codOrderId: string; shopDomain: string; eventName: string };
  [QueueName.FRAUD_SCAN]: { codOrderId: string; shopDomain: string };
  /**
   * Recomputes `DailyStat` for a window from the orders themselves.
   *
   * Dates rather than a duration, so a retry a day later rebuilds the same
   * window the merchant asked for instead of sliding forward with the clock.
   */
  [QueueName.STATS_REBUILD]: { shopId: string; shopDomain: string; from: string; to: string };
  /**
   * The nightly retention sweep. Carries nothing: it runs across every active
   * shop, and each shop's cutoff is derived from its own settings at run time
   * rather than at schedule time — a payload written once and repeated for
   * months would otherwise pin a cutoff that never moves.
   */
  [QueueName.DATA_RETENTION]: Record<string, never>;
  [QueueName.AUTOMATION]: { automationId: string; codOrderId: string; shopDomain: string };
  [QueueName.NOTIFICATION]: { templateKey: string; shopDomain: string; codOrderId?: string };
}

/**
 * Job names within a queue.
 *
 * BullMQ keys deduplication and metrics on the job *id*, not the name, but a
 * meaningful name is what makes the Bull Board dashboard readable during an
 * incident.
 */
export const JobName = {
  PUSH_ORDER: 'push-order',
  SYNC_ORDER: 'sync-order',
  DISPATCH_EVENT: 'dispatch-event',
  SCAN_ORDER: 'scan-order',
  REBUILD_STATS: 'rebuild-stats',
  ENFORCE_RETENTION: 'enforce-retention',
  RUN_AUTOMATION: 'run-automation',
  SEND_NOTIFICATION: 'send-notification',
} as const;

export type JobName = (typeof JobName)[keyof typeof JobName];

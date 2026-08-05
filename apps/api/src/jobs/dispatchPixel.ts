import type { PixelEventName } from '@prisma/client';
import type { Job } from 'bullmq';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/errors';
import { dispatch } from '../modules/pixels/dispatcher';
import type { JobPayloads, QueueName } from '../queue/types';

const log = createLogger('job:pixel-dispatch');

type PixelJob = JobPayloads[typeof QueueName.PIXEL_DISPATCH];

/**
 * Processor for the pixel queue.
 *
 * Throws only when a retry could plausibly help. That distinction is the whole
 * job: an ad platform rejecting a payload as malformed will reject it
 * identically five more times, and retrying only delays the failure while
 * burning the merchant's API quota. A 429 or a socket reset is the opposite.
 *
 * The dispatcher classifies each provider's response, and `shouldRetry` is true
 * only when at least one failure was transient — so a batch where Meta
 * succeeded and TikTok returned a validation error completes rather than
 * re-sending to Meta.
 */
export async function processPixelDispatch(job: Job<PixelJob>): Promise<void> {
  const { codOrderId, eventName } = job.data;

  const summary = await dispatch(codOrderId, eventName as PixelEventName, job.attemptsMade + 1);

  if (summary.shouldRetry) {
    // Re-sending on retry is safe: the dispatcher checks `alreadyDispatched`
    // per pixel, so providers that already accepted the event are skipped
    // rather than sent a duplicate.
    throw new Error(
      `${summary.failed} pixel dispatch(es) failed transiently for ${eventName} — retrying`,
    );
  }
}

/** Logged and dropped. A lost conversion event never affects the order itself. */
export function onPixelDispatchFailed(job: Job<PixelJob> | undefined, error: Error): void {
  if (!job) return;

  const attemptsAllowed = job.opts.attempts ?? 1;
  const exhausted = job.attemptsMade >= attemptsAllowed;

  log.error(
    {
      err: toError(error),
      codOrderId: job.data.codOrderId,
      event: job.data.eventName,
      attempt: job.attemptsMade,
      exhausted,
    },
    exhausted
      ? 'Pixel event could not be delivered — the order is unaffected'
      : 'Pixel dispatch failed, will retry',
  );
}

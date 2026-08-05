import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../config/env';
import { createLogger } from '../lib/logger';

const log = createLogger('redis');

/**
 * Redis connections.
 *
 * Two separate clients, deliberately:
 *
 *  - `redis` — caching and rate limiting. Fails fast so a Redis outage degrades
 *    a request instead of hanging it.
 *  - `queueConnection` — BullMQ. Requires `maxRetriesPerRequest: null` because
 *    its blocking commands (BRPOPLPUSH) legitimately stay open indefinitely;
 *    with a retry limit ioredis aborts them and BullMQ throws. BullMQ refuses
 *    to start otherwise, so this is not tunable.
 *  - `rateLimitConnection` — the rate limiter, which drives Redis through
 *    `EVALSHA`. ioredis does not apply `keyPrefix` to scripts' `KEYS`, so a
 *    client with a prefix would namespace ordinary commands but not the limiter
 *    counters. Rather than reason about that per command, this connection
 *    carries no prefix and the limiter store applies its own.
 */

function baseOptions(): RedisOptions {
  return {
    keyPrefix: `${config.redis.prefix}:`,
    // Do not queue commands issued while disconnected — surface the failure
    // rather than replaying a burst of stale writes on reconnect.
    enableOfflineQueue: false,
    connectTimeout: 10_000,
    retryStrategy(times: number): number | null {
      if (times > 10) {
        log.error({ times }, 'Redis retry limit reached, giving up');
        return null;
      }
      // Exponential-ish backoff, capped at 3s.
      return Math.min(times * 200, 3_000);
    },
    reconnectOnError(error: Error): boolean {
      // A failover promotes a replica; the old primary starts returning READONLY.
      // Reconnecting picks up the new primary.
      return error.message.includes('READONLY');
    },
  };
}

function attachLogging(client: Redis, name: string): Redis {
  client.on('connect', () => log.info({ client: name }, 'Redis connecting'));
  client.on('ready', () => log.info({ client: name }, 'Redis ready'));
  client.on('error', (error: Error) => log.error({ client: name, err: error }, 'Redis error'));
  client.on('close', () => log.warn({ client: name }, 'Redis connection closed'));
  client.on('reconnecting', () => log.warn({ client: name }, 'Redis reconnecting'));
  return client;
}

declare global {
  // eslint-disable-next-line no-var
  var __codflowRedis: Redis | undefined;
  // eslint-disable-next-line no-var
  var __codflowQueueRedis: Redis | undefined;
  // eslint-disable-next-line no-var
  var __codflowRateLimitRedis: Redis | undefined;
}

function createAppRedis(): Redis {
  return attachLogging(new Redis(config.redis.url, baseOptions()), 'app');
}

function createQueueRedis(): Redis {
  return attachLogging(
    new Redis(config.redis.url, {
      ...baseOptions(),
      // BullMQ manages its own key namespacing via the queue prefix; a client
      // keyPrefix on top would corrupt the keys it computes internally.
      keyPrefix: undefined,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    }),
    'queue',
  );
}

function createRateLimitRedis(): Redis {
  return attachLogging(
    new Redis(config.redis.url, {
      ...baseOptions(),
      keyPrefix: undefined,
      // A rate limiter that queues commands during an outage would admit the
      // burst it exists to stop, then replay the counters afterwards.
      enableOfflineQueue: false,
    }),
    'rate-limit',
  );
}

export const redis: Redis = globalThis.__codflowRedis ?? createAppRedis();
export const queueConnection: Redis = globalThis.__codflowQueueRedis ?? createQueueRedis();
export const rateLimitConnection: Redis =
  globalThis.__codflowRateLimitRedis ?? createRateLimitRedis();

/** True once the rate-limit connection has been usable at least once. */
let rateLimitWasReady = rateLimitConnection.status === 'ready';
rateLimitConnection.on('ready', () => {
  rateLimitWasReady = true;
});

/**
 * Waits out the *initial* connection, and only that.
 *
 * `rate-limit-redis` loads its increment script when the store is constructed,
 * and the limiters are module-level constants — so that load runs during import,
 * while the socket is still opening. With `enableOfflineQueue: false` ioredis
 * rejects it outright, and every boot logged a stack trace ending in
 * "Stream isn't writeable" while the script silently went unloaded.
 *
 * Waiting is right for that one case and wrong for every other. Once the
 * connection has been ready once, this returns immediately and a command issued
 * during a later outage fails fast exactly as intended — which is the whole
 * point of disabling the offline queue on this connection. Blocking requests
 * behind a reconnect would turn a Redis blip into an app-wide stall.
 */
export async function awaitRateLimitReady(timeoutMs = 5_000): Promise<void> {
  if (rateLimitWasReady || rateLimitConnection.status === 'ready') return;

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanup();
      resolve();
    };

    const onTimeout = (): void => {
      cleanup();
      reject(new Error('Redis was not ready in time for the rate limiter'));
    };

    const timer = setTimeout(onTimeout, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      rateLimitConnection.off('ready', onReady);
    }

    rateLimitConnection.once('ready', onReady);
  });
}

if (!config.isProduction) {
  globalThis.__codflowRedis = redis;
  globalThis.__codflowQueueRedis = queueConnection;
  globalThis.__codflowRateLimitRedis = rateLimitConnection;
}

/**
 * How long the readiness wait below tolerates a connection in progress.
 *
 * Longer than a healthy local or same-region connect by a wide margin, and short
 * enough that a genuinely unreachable Redis still fails the boot quickly rather
 * than leaving a container in "starting" until the platform's own timeout.
 */
const READY_TIMEOUT_MS = 5_000;

/**
 * Whether Redis is reachable.
 *
 * The wait for `ready` is the whole point. ioredis connects asynchronously from
 * the moment the client is constructed, and these clients run with
 * `enableOfflineQueue: false` — deliberately, so a command issued during an
 * outage fails fast instead of piling up. The consequence is that a `ping()`
 * sent while the socket is still opening does not wait: it throws
 * "Stream isn't writeable and enableOfflineQueue options is false".
 *
 * At boot that race is the common case, not the rare one — `server.ts` checks
 * dependencies immediately after import, microseconds after the client was
 * created. The result was a process that refused to start against a Redis that
 * was running and healthy, reporting "check REDIS_URL and that Redis is
 * running" while `redis-cli ping` answered PONG.
 *
 * Resolving only on `ready` and failing only on the timeout is what makes this
 * honest: a transient error mid-connect is what `retryStrategy` exists to
 * absorb, so it is logged rather than treated as fatal.
 */
export async function checkRedisConnection(): Promise<boolean> {
  try {
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Redis was still ${redis.status} after ${READY_TIMEOUT_MS}ms`)),
          READY_TIMEOUT_MS,
        );

        const onReady = (): void => {
          clearTimeout(timer);
          redis.off('error', onError);
          resolve();
        };

        const onError = (error: Error): void => {
          // Not fatal on its own; the retry strategy may still get there.
          log.warn({ err: error }, 'Redis error while waiting for the connection');
        };

        redis.once('ready', onReady);
        redis.on('error', onError);
      });
    }

    const reply = await redis.ping();
    return reply === 'PONG';
  } catch (error) {
    log.error({ err: error }, 'Redis connection check failed');
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  // `quit` drains in-flight commands; `disconnect` would drop them.
  await Promise.allSettled([redis.quit(), queueConnection.quit(), rateLimitConnection.quit()]);
  log.info('Redis disconnected');
}

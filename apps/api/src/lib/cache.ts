import { createHash } from 'node:crypto';
import { redis } from '../redis';
import { createLogger } from './logger';
import { toError } from './errors';

const log = createLogger('cache');

/**
 * Redis-backed response cache.
 *
 * Exists for one workload: the storefront config endpoint, which is hit by
 * every product page view on every installed store. Without a cache that is one
 * database round trip per shopper, and the read is identical for everyone
 * looking at the same product.
 *
 * Two properties are deliberate:
 *
 *  - **A cache failure is never a request failure.** Every operation swallows
 *    its error and behaves as a miss. A Redis outage should make the storefront
 *    slower, not broken — a shopper who cannot see the COD button is a lost
 *    sale for the merchant.
 *  - **Invalidation is by tag, not by key.** A merchant editing one button has
 *    to invalidate every cached product variant of that shop's config, and
 *    enumerating those keys is not something to attempt with `KEYS` on a shared
 *    Redis. Tags are versioned counters instead: bumping a shop's version makes
 *    every key derived from it unreachable, and the old entries expire on their
 *    own TTL.
 */

/** Namespaced key. The `redis` client already applies the global prefix. */
function cacheKey(namespace: string, parts: readonly string[], tagVersion: number): string {
  return `cache:${namespace}:v${tagVersion}:${parts.join(':')}`;
}

function tagKey(tag: string): string {
  return `cachetag:${tag}`;
}

/**
 * Current version of a tag.
 *
 * A missing counter reads as version 0, so a cold Redis behaves like an empty
 * cache rather than an error.
 */
async function currentTagVersion(tag: string): Promise<number> {
  try {
    const value = await redis.get(tagKey(tag));
    return value ? Number.parseInt(value, 10) || 0 : 0;
  } catch (error) {
    log.warn({ err: toError(error), tag }, 'Could not read cache tag version');
    return 0;
  }
}

/**
 * Invalidates everything published under a tag.
 *
 * `INCR` is atomic, so two merchants saving settings simultaneously cannot land
 * on the same version and resurrect each other's stale entries. Orphaned
 * entries under the previous version are never read again and expire on TTL.
 */
export async function invalidateTag(tag: string): Promise<void> {
  try {
    await redis.incr(tagKey(tag));
    log.debug({ tag }, 'Cache tag invalidated');
  } catch (error) {
    // Logged loudly: a failed invalidation means merchants keep seeing stale
    // config until the TTL expires, which is a support ticket waiting to happen.
    log.error({ err: toError(error), tag }, 'Cache invalidation failed — entries will serve stale until TTL');
  }
}

export interface CacheOptions {
  /** Logical group, e.g. `storefront-config`. Part of the key. */
  namespace: string;
  /** Values that make this entry unique — shop domain, product id. */
  parts: readonly string[];
  /** Invalidation group, normally the shop domain. */
  tag: string;
  /** Seconds. Also the ceiling on how long a failed invalidation can serve stale. */
  ttlSeconds: number;
}

/**
 * Reads through the cache, computing the value on a miss.
 *
 * The stampede case is worth noting and is deliberately *not* handled with a
 * lock: when a popular product's entry expires, several concurrent requests
 * will each recompute it. For this workload that is a handful of extra database
 * reads, which is cheaper and far simpler than distributed locking — and a lock
 * held by a process that dies mid-computation is its own outage.
 */
export async function remember<T>(options: CacheOptions, compute: () => Promise<T>): Promise<T> {
  const version = await currentTagVersion(options.tag);
  const key = cacheKey(options.namespace, options.parts, version);

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    // A malformed entry (a truncated write, a format change between deploys)
    // parses as a miss rather than throwing at the caller.
    log.warn({ err: toError(error), key }, 'Cache read failed — recomputing');
  }

  const value = await compute();

  try {
    await redis.set(key, JSON.stringify(value), 'EX', options.ttlSeconds);
  } catch (error) {
    log.warn({ err: toError(error), key }, 'Cache write failed');
  }

  return value;
}

/** Removes a single entry without disturbing the rest of its tag. */
export async function forget(options: Omit<CacheOptions, 'ttlSeconds'>): Promise<void> {
  try {
    const version = await currentTagVersion(options.tag);
    await redis.del(cacheKey(options.namespace, options.parts, version));
  } catch (error) {
    log.warn({ err: toError(error) }, 'Cache delete failed');
  }
}

/**
 * Short, stable fingerprint of a value.
 *
 * Serves as the storefront config's `version`, which the browser compares
 * against its `sessionStorage` copy. Truncated to 16 hex characters — enough
 * that an accidental collision between two configs of the same shop is not a
 * realistic concern, short enough not to bloat every response.
 */
export function contentVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/** Tag covering everything derived from one shop's configuration. */
export function shopTag(shopDomain: string): string {
  return `shop:${shopDomain}`;
}

import type { Request, Response } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config/env';
import { awaitRateLimitReady, rateLimitConnection } from '../redis';
import { createLogger } from '../lib/logger';
import { normalizeShopDomain } from '../lib/shopDomain';
import { RateLimitError } from '../lib/errors';

const log = createLogger('rate-limit');

/**
 * Distributed rate limiting.
 *
 * Backed by Redis rather than memory because the API runs as more than one
 * process (web + worker, and multiple web replicas in production). An in-memory
 * limiter would divide every quota by the replica count and let an attacker
 * multiply their allowance by reconnecting.
 *
 * Limits are keyed by tenant where a tenant is known, and by IP otherwise. That
 * distinction matters: keying admin traffic by IP would let one busy merchant
 * behind a corporate NAT throttle their colleagues, while keying public
 * storefront traffic by shop alone would let one abusive visitor lock out every
 * shopper on that store.
 */

function createStore(scope: string): RedisStore {
  return new RedisStore({
    prefix: `${config.redis.prefix}:rl:${scope}:`,
    // ioredis accepts raw commands via `call`. rate-limit-redis drives EVALSHA
    // through this, which is why the connection deliberately has no keyPrefix.
    sendCommand: async (...args: string[]) => {
      // The store loads its increment script the moment it is constructed, and
      // these limiters are module-level constants — so that first command races
      // the socket opening. This waits out the initial connect and nothing
      // else; see `awaitRateLimitReady`.
      await awaitRateLimitReady();

      return rateLimitConnection.call(args[0] as string, ...args.slice(1)) as Promise<never>;
    },
  });
}

/**
 * A limiter breach is not an error the operator needs to act on, but it is
 * exactly what you want in the log when a merchant reports intermittent
 * failures — so it is logged at warn with enough context to identify the actor.
 */
function rejection(scope: string) {
  return (req: Request, res: Response): void => {
    const retryAfter = Number(res.getHeader('Retry-After')) || undefined;

    log.warn(
      { scope, ip: req.ip, path: req.path, shop: req.auth?.shopDomain ?? null },
      'Rate limit exceeded',
    );

    throw new RateLimitError('Too many requests — slow down and try again shortly', {
      details: { scope },
      ...(retryAfter ? { retryAfter } : {}),
    });
  };
}

const shared = {
  // draft-8 emits the single `RateLimit` header; the legacy `X-RateLimit-*`
  // trio is off because nothing in this app consumes it.
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  /**
   * Fail open when Redis is unreachable.
   *
   * The store's counters live in Redis, and the connection deliberately has no
   * offline queue — so during an outage every increment throws. Left at the
   * default, that error propagates and *every* rate-limited route returns 500:
   * a Redis blip would take the entire admin and all COD order intake down,
   * which is a far larger failure than the burst the limiter exists to stop.
   *
   * Overridden to `false` on the OTP limiter, where the trade runs the other
   * way — see the note there.
   */
  passOnStoreError: true,
};

/**
 * `/api/admin/*` — one bucket per shop.
 *
 * Falls back to IP before authentication resolves, which covers the window
 * where a bad session token is being retried in a loop.
 */
export const adminRateLimit: RateLimitRequestHandler = rateLimit({
  ...shared,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.maxAdmin,
  store: createStore('admin'),
  keyGenerator: (req: Request) =>
    req.auth?.shopDomain ?? normalizeShopDomain(req.query.shop as string) ?? ipKeyGenerator(req.ip ?? ''),
  handler: rejection('admin'),
});

/**
 * `/api/storefront/*` — the app's real attack surface.
 *
 * These endpoints are unauthenticated by design (a shopper has no credentials),
 * so the quota is per shop *and* per IP: abuse from one visitor cannot exhaust
 * the store's allowance, and a distributed flood still meets a per-shop ceiling
 * further up the stack.
 */
export const storefrontRateLimit: RateLimitRequestHandler = rateLimit({
  ...shared,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.maxStorefront,
  store: createStore('storefront'),
  keyGenerator: (req: Request) => {
    const shop =
      normalizeShopDomain(req.get('x-codflow-shop')) ??
      normalizeShopDomain(req.query.shop as string) ??
      'unknown';
    return `${shop}|${ipKeyGenerator(req.ip ?? '')}`;
  },
  handler: rejection('storefront'),
});

/**
 * OTP sends — the tightest bucket in the app.
 *
 * Every send costs the merchant real money at their SMS provider, so this
 * protects a budget as much as it protects the service. Keyed on IP plus the
 * destination so neither one alone can be used to pump another party's phone.
 *
 * The only limiter that fails *closed*. Everywhere else a Redis outage should
 * not stop merchants working, but here an unbounded window bills the merchant
 * for every message sent — and unlike a lost page view, that cost is not
 * recoverable once the outage ends.
 */
export const otpRateLimit: RateLimitRequestHandler = rateLimit({
  ...shared,
  passOnStoreError: false,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.maxOtp,
  store: createStore('otp'),
  keyGenerator: (req: Request) => {
    const destination =
      typeof req.body === 'object' && req.body !== null
        ? String((req.body as Record<string, unknown>).phone ?? '')
        : '';
    return `${ipKeyGenerator(req.ip ?? '')}|${destination}`;
  },
  handler: rejection('otp'),
});

/**
 * `/api/auth/*` — the unauthenticated entry points.
 *
 * Generous enough for a merchant reloading a broken embedded app repeatedly,
 * tight enough that the install and exit-iframe routes cannot be used as an
 * open redirect amplifier.
 */
export const authRateLimit: RateLimitRequestHandler = rateLimit({
  ...shared,
  windowMs: config.rateLimit.windowMs,
  limit: 60,
  store: createStore('auth'),
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? ''),
  handler: rejection('auth'),
});

/**
 * Webhooks — a backstop, not a quota.
 *
 * Shopify legitimately bursts (a bulk fulfilment can emit hundreds of events in
 * a second), and rejecting a genuine delivery costs a retry with backoff. The
 * ceiling is set high enough that only a forged flood reaches it, and it is
 * keyed on the claimed shop domain so one shop cannot starve the others.
 * Verification still runs afterwards — this only bounds the work done before
 * the HMAC check.
 */
export const webhookRateLimit: RateLimitRequestHandler = rateLimit({
  ...shared,
  windowMs: 10_000,
  limit: 500,
  store: createStore('webhook'),
  keyGenerator: (req: Request) =>
    normalizeShopDomain(req.get('x-shopify-shop-domain')) ?? ipKeyGenerator(req.ip ?? ''),
  handler: rejection('webhook'),
});

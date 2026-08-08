import { Session } from '@shopify/shopify-api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Token renewal.
 *
 * The behaviour under test is the one that made every Admin API call fail: the
 * app held a permanent offline token, Shopify stopped accepting them, and
 * nothing in the code could notice or recover. So the assertions are less about
 * the happy path than about the two ways this can silently go wrong again —
 * renewing when it should not, and failing loudly enough to break a caller that
 * was previously working.
 */

const migrateToExpiringToken = vi.fn();
const refreshToken = vi.fn();

vi.mock('./client', () => ({
  shopify: { auth: { migrateToExpiringToken, refreshToken } },
}));

const { ensureUsableToken, forceRefresh } = await import('./tokenRefresh');

const SHOP = 'demo.myshopify.com';
const SCOPES = 'read_products,write_orders';

function session(overrides: Partial<Session> = {}): Session {
  return new Session({
    id: `offline_${SHOP}`,
    shop: SHOP,
    state: '',
    isOnline: false,
    accessToken: 'shpua_original',
    scope: SCOPES,
    ...overrides,
  } as ConstructorParameters<typeof Session>[0]);
}

/** A token expiring `minutes` from now. Negative means already expired. */
function expiringIn(minutes: number, overrides: Partial<Session> = {}): Session {
  return session({
    expires: new Date(Date.now() + minutes * 60_000),
    refreshToken: 'refresh_original',
    ...overrides,
  });
}

function harness(stored: Session) {
  let current = stored;

  return {
    reload: vi.fn(async () => current),
    store: vi.fn(async (next: Session) => {
      current = next;
    }),
    get current() {
      return current;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a deprecated permanent token', () => {
  it('is migrated to an expiring one', async () => {
    const stored = session();
    const io = harness(stored);

    migrateToExpiringToken.mockResolvedValue({
      session: expiringIn(60, { accessToken: 'shpua_expiring', scope: undefined }),
    });

    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(migrateToExpiringToken).toHaveBeenCalledWith({
      shop: SHOP,
      nonExpiringOfflineAccessToken: 'shpua_original',
    });
    expect(result.accessToken).toBe('shpua_expiring');
    expect(io.store).toHaveBeenCalledOnce();
  });

  it('keeps the scope, which the migration response does not return', async () => {
    const stored = session();
    const io = harness(stored);

    migrateToExpiringToken.mockResolvedValue({
      session: expiringIn(60, { scope: undefined }),
    });

    const result = await ensureUsableToken(stored, io.reload, io.store);

    // Losing the scope would make the auth middleware believe the grant had
    // narrowed and re-exchange on every single request.
    expect(result.scope).toBe(SCOPES);
  });

  it('is never refreshed — it has no refresh token to trade', async () => {
    const stored = session();
    const io = harness(stored);

    migrateToExpiringToken.mockResolvedValue({ session: expiringIn(60) });

    await ensureUsableToken(stored, io.reload, io.store);

    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe('an expiring token', () => {
  it('is left alone while it has time left', async () => {
    const stored = expiringIn(30);
    const io = harness(stored);

    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(result).toBe(stored);
    expect(refreshToken).not.toHaveBeenCalled();
    expect(migrateToExpiringToken).not.toHaveBeenCalled();
    expect(io.store).not.toHaveBeenCalled();
  });

  it('is refreshed inside the safety margin, before it actually expires', async () => {
    // Still valid, but not for long enough to survive a slow order push.
    const stored = expiringIn(2);
    const io = harness(stored);

    refreshToken.mockResolvedValue({
      session: expiringIn(60, { accessToken: 'shpua_refreshed' }),
    });

    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(refreshToken).toHaveBeenCalledWith({ shop: SHOP, refreshToken: 'refresh_original' });
    expect(result.accessToken).toBe('shpua_refreshed');
  });

  it('is refreshed once it has expired', async () => {
    const stored = expiringIn(-10);
    const io = harness(stored);

    refreshToken.mockResolvedValue({
      session: expiringIn(60, { accessToken: 'shpua_refreshed' }),
    });

    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(result.accessToken).toBe('shpua_refreshed');
  });
});

describe('concurrency', () => {
  it('collapses a burst for one shop into a single renewal', async () => {
    const stored = expiringIn(-1);
    const io = harness(stored);

    refreshToken.mockResolvedValue({ session: expiringIn(60) });

    // Ten queued jobs waking at once is the realistic shape of this.
    await Promise.all(
      Array.from({ length: 10 }, () => ensureUsableToken(stored, io.reload, io.store)),
    );

    expect(refreshToken).toHaveBeenCalledOnce();
  });

  it('uses what another process already wrote instead of renewing again', async () => {
    const stale = expiringIn(-1);

    // The web service renewed between this caller loading and acting on it.
    const reload = vi.fn(async () => expiringIn(60, { accessToken: 'shpua_from_web' }));
    const store = vi.fn(async () => undefined);

    const result = await ensureUsableToken(stale, reload, store);

    expect(result.accessToken).toBe('shpua_from_web');
    expect(refreshToken).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it('releases the in-flight slot so a later expiry renews again', async () => {
    const io = harness(expiringIn(-1));

    refreshToken.mockResolvedValue({ session: expiringIn(60) });
    await ensureUsableToken(expiringIn(-1), io.reload, io.store);

    const second = harness(expiringIn(-1));
    refreshToken.mockResolvedValue({ session: expiringIn(60) });
    await ensureUsableToken(expiringIn(-1), second.reload, second.store);

    expect(refreshToken).toHaveBeenCalledTimes(2);
  });
});

describe('failure', () => {
  it('returns the stored session rather than throwing at the caller', async () => {
    const stored = expiringIn(-1);
    const io = harness(stored);

    refreshToken.mockRejectedValue(new Error('Shopify is down'));

    // A throw here would turn a token problem into a crashed order push — the
    // caller is no worse off proceeding with what it had.
    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(result.accessToken).toBe('shpua_original');
    expect(io.store).not.toHaveBeenCalled();
  });

  it('does not store anything when migration fails', async () => {
    const stored = session();
    const io = harness(stored);

    migrateToExpiringToken.mockRejectedValue(new Error('nope'));

    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(result).toBe(stored);
    expect(io.store).not.toHaveBeenCalled();
  });

  it('gives up when an expired token has no refresh token', async () => {
    const stored = session({ expires: new Date(Date.now() - 60_000) });
    const io = harness(stored);

    const result = await ensureUsableToken(stored, io.reload, io.store);

    expect(result).toBe(stored);
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe('forceRefresh, for a token Shopify rejected mid-request', () => {
  it('refreshes a token the expiry check thought was still healthy', async () => {
    // The case the pre-flight margin cannot catch: enqueued while valid, run an
    // hour later. Shopify says 401; the clock here says there is time left.
    const stale = expiringIn(30);

    refreshToken.mockResolvedValue({
      session: expiringIn(60, { accessToken: 'shpua_recovered' }),
    });

    const result = await forceRefresh(stale);

    expect(result?.accessToken).toBe('shpua_recovered');
  });

  it('returns null when there is no refresh token to spend', async () => {
    // A permanent token that was rejected. Nothing to trade — this really is a
    // dead grant, and the caller should purge.
    expect(await forceRefresh(session())).toBeNull();
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('returns null rather than throwing when Shopify refuses the refresh', async () => {
    refreshToken.mockRejectedValue(new Error('invalid_grant'));

    expect(await forceRefresh(expiringIn(-1))).toBeNull();
  });
});

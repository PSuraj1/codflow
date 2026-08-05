import { config } from '../config/env';
import { createLogger } from './logger';
import { remember } from './cache';
import { toError } from './errors';

const log = createLogger('ip-intel');

/**
 * IP intelligence.
 *
 * Answers whether an address is a VPN exit, an open proxy, a Tor node or a
 * datacentre — signals a COD merchant cannot get any other way, because none of
 * them are visible in the order itself.
 *
 * Three properties shape this module, and all three come from where it runs:
 * on the shopper's submission path, against a third-party API, for a check that
 * is advisory rather than decisive.
 *
 *  1. **Bounded.** A hard timeout, because a slow provider must not hold up a
 *     shopper's order. An absent answer costs one signal; a hung request costs
 *     the sale.
 *  2. **Cached.** Aggressively, by IP. A repeat visitor, a shared office
 *     connection or a burst of orders from one mobile carrier all resolve to
 *     the same address, and the answer does not change minute to minute.
 *  3. **Fails open.** A provider outage returns "unknown", never "suspicious".
 *     Treating an unreachable API as evidence against a shopper would turn a
 *     third party's downtime into blocked orders for the merchant.
 */

export interface IpIntelResult {
  readonly countryCode: string | null;
  readonly isVpn: boolean | null;
  readonly isProxy: boolean | null;
  readonly isTor: boolean | null;
  readonly isHosting: boolean | null;
  /** 0–100, higher is worse. Null when the provider offers no score. */
  readonly reputationScore: number | null;
  /** True when the lookup succeeded. False means every field above is a guess. */
  readonly resolved: boolean;
}

const UNKNOWN: IpIntelResult = {
  countryCode: null,
  isVpn: null,
  isProxy: null,
  isTor: null,
  isHosting: null,
  reputationScore: null,
  resolved: false,
};

/**
 * How long a shopper waits for a provider.
 *
 * 2.5 seconds is generous for an API that normally answers in under 200ms, and
 * short enough that a degraded provider does not make the COD form feel broken.
 */
const LOOKUP_TIMEOUT_MS = 2_500;

/**
 * Cache lifetime.
 *
 * A day. VPN exit nodes and datacentre ranges are stable over that horizon, and
 * the alternative — paying for a lookup per order — is what makes merchants
 * turn the feature off.
 */
const CACHE_TTL_SECONDS = 24 * 3_600;

/** Private and loopback ranges never reach a provider. */
function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }

  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;

  // 172.16.0.0 – 172.31.255.255
  const match = /^172\.(\d+)\./.exec(ip);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }

  return false;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    return await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * IPQualityScore. The most detailed of the three, and the one whose
 * `fraud_score` is worth surfacing directly.
 */
async function queryIpQualityScore(ip: string, apiKey: string): Promise<IpIntelResult> {
  const url = `https://www.ipqualityscore.com/api/json/ip/${encodeURIComponent(apiKey)}/${encodeURIComponent(ip)}?strictness=1&allow_public_access_points=true`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`IPQualityScore returned ${response.status}`);

  const body = (await response.json()) as {
    success?: boolean;
    country_code?: string;
    vpn?: boolean;
    proxy?: boolean;
    tor?: boolean;
    // Their flag for datacentre/hosting ranges.
    is_crawler?: boolean;
    connection_type?: string;
    fraud_score?: number;
  };

  if (body.success === false) throw new Error('IPQualityScore rejected the request');

  return {
    countryCode: body.country_code ?? null,
    isVpn: body.vpn ?? null,
    isProxy: body.proxy ?? null,
    isTor: body.tor ?? null,
    isHosting: body.connection_type ? body.connection_type === 'Data Center' : null,
    reputationScore: typeof body.fraud_score === 'number' ? body.fraud_score : null,
    resolved: true,
  };
}

/** proxycheck.io. Cheaper, and explicit about VPN versus Tor. */
async function queryProxyCheck(ip: string, apiKey: string): Promise<IpIntelResult> {
  const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?key=${encodeURIComponent(apiKey)}&vpn=3&asn=1&risk=1`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`proxycheck returned ${response.status}`);

  const body = (await response.json()) as Record<string, unknown>;

  if (body.status !== 'ok') throw new Error(`proxycheck status ${String(body.status)}`);

  const entry = body[ip] as
    | {
        proxy?: string;
        type?: string;
        risk?: number;
        isocode?: string;
      }
    | undefined;

  if (!entry) throw new Error('proxycheck returned no entry for the address');

  const isProxy = entry.proxy === 'yes';
  const type = (entry.type ?? '').toUpperCase();

  return {
    countryCode: entry.isocode ?? null,
    isVpn: isProxy && type === 'VPN',
    isProxy,
    isTor: type === 'TOR',
    isHosting: type === 'HOSTING' || type === 'COMPROMISED SERVER',
    reputationScore: typeof entry.risk === 'number' ? entry.risk : null,
    resolved: true,
  };
}

/**
 * ip-api.com. Free tier, no key, and the only one of the three that offers no
 * reputation score — so `IP_REPUTATION` never fires under this provider.
 */
async function queryIpApi(ip: string): Promise<IpIntelResult> {
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,proxy,hosting`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`ip-api returned ${response.status}`);

  const body = (await response.json()) as {
    status?: string;
    countryCode?: string;
    proxy?: boolean;
    hosting?: boolean;
  };

  if (body.status !== 'success') throw new Error('ip-api could not resolve the address');

  return {
    countryCode: body.countryCode ?? null,
    // ip-api's `proxy` flag covers VPN and Tor without distinguishing them.
    // Reporting VPN and Tor as null rather than guessing keeps the signals
    // honest — a false Tor flag is 60 points.
    isVpn: null,
    isProxy: body.proxy ?? null,
    isTor: null,
    isHosting: body.hosting ?? null,
    reputationScore: null,
    resolved: true,
  };
}

/**
 * Looks an address up, cached and bounded.
 *
 * Never throws. Every failure path returns `UNKNOWN`, which the engine reads as
 * "no network signals" rather than as evidence.
 */
export async function lookupIp(ip: string | null): Promise<IpIntelResult> {
  if (!ip || isPrivateAddress(ip)) return UNKNOWN;
  if (!config.ipIntel.isConfigured) return UNKNOWN;

  const provider = config.ipIntel.provider;
  const apiKey = config.ipIntel.apiKey ?? '';

  return remember(
    {
      namespace: `ip-intel:${provider}`,
      parts: [ip],
      // Shared across shops: an IP's nature is a property of the address, not
      // of who is looking. One lookup serves every merchant.
      tag: 'ip-intel',
      ttlSeconds: CACHE_TTL_SECONDS,
    },
    async () => {
      try {
        switch (provider) {
          case 'ipqualityscore':
            return await queryIpQualityScore(ip, apiKey);
          case 'proxycheck':
            return await queryProxyCheck(ip, apiKey);
          case 'ipapi':
            return await queryIpApi(ip);
          default:
            return UNKNOWN;
        }
      } catch (error) {
        // Fails open. A provider outage must not become blocked orders.
        log.warn({ err: toError(error), provider }, 'IP intelligence lookup failed');
        return UNKNOWN;
      }
    },
  );
}

export const IP_INTEL_UNKNOWN = UNKNOWN;

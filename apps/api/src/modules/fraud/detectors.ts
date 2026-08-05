import { BlockListScope, BlockListType } from '@prisma/client';
import { DEFAULT_SIGNAL_WEIGHTS, RiskSignal, type RiskSignalResult } from '@codflow/shared';
import { createLogger } from '../../lib/logger';
import { toError } from '../../lib/errors';
import { looksFabricated } from '../../lib/phone';
import { isDisposableEmailDomain } from '../../data/disposableEmailDomains';
import * as repository from './repository';
import { signal, type Detector, type DetectorContext } from './types';

const log = createLogger('fraud-detectors');

/**
 * The detectors.
 *
 * Each is independent, reads only its `DetectorContext`, and returns signals
 * rather than verdicts. Scoring, thresholds and the final action all belong to
 * the engine — a detector that decided to block an order would make the
 * merchant's threshold settings meaningless.
 */

const weight = (code: string): number => DEFAULT_SIGNAL_WEIGHTS[code] ?? 0;

function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

/** Midnight is not the right boundary — a "daily" limit is a rolling 24 hours. */
function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

// ---------------------------------------------------------------------------
// Block lists
// ---------------------------------------------------------------------------

/**
 * The merchant's own lists.
 *
 * Weighted at 100 — an outright block — because unlike every other signal this
 * is not an inference. The merchant looked at this number and decided. A
 * whitelist entry short-circuits the entire assessment, which is how a merchant
 * rescues a good customer the engine keeps flagging.
 */
export const blockListDetector: Detector = async ({ subject, settings, now }) => {
  if (!settings.checkBlockList) return [];

  const lookups: Array<{ scope: BlockListScope; value: string }> = [];

  if (subject.phoneE164) lookups.push({ scope: BlockListScope.PHONE, value: subject.phoneE164 });
  if (subject.email) {
    lookups.push({ scope: BlockListScope.EMAIL, value: subject.email.toLowerCase() });
  }
  if (subject.ipAddress) lookups.push({ scope: BlockListScope.IP, value: subject.ipAddress });
  if (subject.addressHash) {
    lookups.push({ scope: BlockListScope.ADDRESS, value: subject.addressHash });
  }
  if (subject.postalCode) {
    lookups.push({ scope: BlockListScope.POSTAL_CODE, value: subject.postalCode.toUpperCase() });
  }
  if (subject.countryCode) {
    lookups.push({ scope: BlockListScope.COUNTRY, value: subject.countryCode.toUpperCase() });
  }
  if (subject.deviceFingerprint) {
    lookups.push({
      scope: BlockListScope.DEVICE_FINGERPRINT,
      value: subject.deviceFingerprint,
    });
  }

  const matches = await repository.findBlockListMatches(subject.shopId, lookups, now);
  if (matches.length === 0) return [];

  await repository.recordBlockListHits(matches.map((match) => match.id));

  const whitelisted = matches.filter((match) => match.type === BlockListType.WHITELIST);

  if (whitelisted.length > 0) {
    // A large negative weight rather than an early return, so the whitelist
    // shows up in the breakdown and the merchant can see *why* an otherwise
    // risky order was allowed.
    return [
      {
        code: 'WHITELISTED',
        label: `Trusted by your ${whitelisted[0]?.scope.toLowerCase()} allow list`,
        weight: -1_000,
        matched: true,
        detail: { scopes: whitelisted.map((entry) => entry.scope) },
      },
    ];
  }

  const codeByScope: Record<string, string> = {
    [BlockListScope.PHONE]: RiskSignal.BLACKLISTED_PHONE,
    [BlockListScope.EMAIL]: RiskSignal.BLACKLISTED_EMAIL,
    [BlockListScope.IP]: RiskSignal.BLACKLISTED_IP,
    [BlockListScope.ADDRESS]: RiskSignal.BLACKLISTED_ADDRESS,
    [BlockListScope.POSTAL_CODE]: RiskSignal.BLACKLISTED_POSTAL_CODE,
    [BlockListScope.COUNTRY]: RiskSignal.BLACKLISTED_COUNTRY,
    [BlockListScope.DEVICE_FINGERPRINT]: RiskSignal.BLACKLISTED_DEVICE,
    [BlockListScope.CUSTOMER_ID]: RiskSignal.BLACKLISTED_PHONE,
  };

  return matches.map((match) => {
    const code = codeByScope[match.scope] ?? RiskSignal.BLACKLISTED_PHONE;

    return signal(code, `On your ${match.scope.toLowerCase().replace(/_/g, ' ')} block list`, 100, {
      scope: match.scope,
      reason: match.reason,
      addedBy: match.createdBy,
    });
  });
};

// ---------------------------------------------------------------------------
// Repetition
// ---------------------------------------------------------------------------

/**
 * Repeat orders within the merchant's duplicate window.
 *
 * Weighted low on purpose. A family sharing one phone, an office sharing an
 * address, a customer who genuinely reorders — all of these look identical to
 * this check, and every one of them is a real sale. It contributes to a score
 * rather than deciding anything.
 */
export const duplicateDetector: Detector = async ({ subject, settings, now }) => {
  const window = {
    shopId: subject.shopId,
    since: hoursAgo(now, settings.duplicateWindowHours),
    excludeOrderId: subject.codOrderId,
  };

  const signals: RiskSignalResult[] = [];

  if (settings.checkDuplicatePhone && subject.phoneE164) {
    const count = await repository.countByPhone(window, subject.phoneE164);

    if (count > 0) {
      signals.push(
        signal(
          RiskSignal.DUPLICATE_PHONE,
          `${count} other order${count === 1 ? '' : 's'} from this phone in the last ${settings.duplicateWindowHours}h`,
          // Scales with repetition but caps at three times the base, so ten
          // orders from a busy reseller does not silently become a 180-point
          // block.
          Math.min(weight(RiskSignal.DUPLICATE_PHONE) * count, weight(RiskSignal.DUPLICATE_PHONE) * 3),
          { count, windowHours: settings.duplicateWindowHours },
        ),
      );
    }
  }

  if (settings.checkDuplicateEmail && subject.email) {
    const count = await repository.countByEmail(window, subject.email);

    if (count > 0) {
      signals.push(
        signal(
          RiskSignal.DUPLICATE_EMAIL,
          `${count} other order${count === 1 ? '' : 's'} from this email in the last ${settings.duplicateWindowHours}h`,
          Math.min(weight(RiskSignal.DUPLICATE_EMAIL) * count, weight(RiskSignal.DUPLICATE_EMAIL) * 3),
          { count },
        ),
      );
    }
  }

  if (settings.checkDuplicateAddress && subject.addressHash) {
    const count = await repository.countByAddress(window, subject.addressHash);

    if (count > 0) {
      signals.push(
        signal(
          RiskSignal.DUPLICATE_ADDRESS,
          `${count} other order${count === 1 ? '' : 's'} to this address in the last ${settings.duplicateWindowHours}h`,
          Math.min(
            weight(RiskSignal.DUPLICATE_ADDRESS) * count,
            weight(RiskSignal.DUPLICATE_ADDRESS) * 3,
          ),
          { count },
        ),
      );
    }
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Rate
// ---------------------------------------------------------------------------

/**
 * Bursts and daily ceilings.
 *
 * Velocity is the short window — several orders in an hour, which is what
 * automated abuse looks like. The daily limits are the merchant's explicit
 * policy ceiling, and exceeding one is a stronger statement than merely
 * ordering quickly.
 */
export const velocityDetector: Detector = async ({ subject, settings, now }) => {
  if (!settings.checkVelocity) return [];

  const signals: RiskSignalResult[] = [];

  const burst = {
    shopId: subject.shopId,
    since: minutesAgo(now, settings.velocityWindowMinutes),
    excludeOrderId: subject.codOrderId,
  };

  const daily = {
    shopId: subject.shopId,
    since: hoursAgo(now, 24),
    excludeOrderId: subject.codOrderId,
  };

  if (subject.phoneE164) {
    const [inWindow, inDay, open] = await Promise.all([
      repository.countByPhone(burst, subject.phoneE164),
      repository.countByPhone(daily, subject.phoneE164),
      repository.countOpenOrders(subject.shopId, subject.phoneE164, subject.codOrderId),
    ]);

    if (inWindow >= settings.velocityMaxOrders) {
      signals.push(
        signal(
          RiskSignal.VELOCITY_PHONE,
          `${inWindow} orders from this phone in ${settings.velocityWindowMinutes} minutes`,
          weight(RiskSignal.VELOCITY_PHONE),
          { count: inWindow, windowMinutes: settings.velocityWindowMinutes },
        ),
      );
    }

    if (inDay >= settings.maxOrdersPerDayPerPhone) {
      signals.push(
        signal(
          RiskSignal.DAILY_LIMIT_PHONE,
          `Daily limit reached — ${inDay} orders from this phone in 24h`,
          weight(RiskSignal.DAILY_LIMIT_PHONE),
          { count: inDay, limit: settings.maxOrdersPerDayPerPhone },
        ),
      );
    }

    if (open >= settings.maxOpenCodOrders) {
      signals.push(
        signal(
          RiskSignal.TOO_MANY_OPEN_ORDERS,
          `${open} cash-on-delivery orders still undelivered for this customer`,
          weight(RiskSignal.TOO_MANY_OPEN_ORDERS),
          { count: open, limit: settings.maxOpenCodOrders },
        ),
      );
    }
  }

  if (subject.ipAddress) {
    const [inWindow, inDay] = await Promise.all([
      repository.countByIp(burst, subject.ipAddress),
      repository.countByIp(daily, subject.ipAddress),
    ]);

    if (inWindow >= settings.velocityMaxOrders) {
      signals.push(
        signal(
          RiskSignal.VELOCITY_IP,
          `${inWindow} orders from this network in ${settings.velocityWindowMinutes} minutes`,
          weight(RiskSignal.VELOCITY_IP),
          { count: inWindow },
        ),
      );
    }

    if (inDay >= settings.maxOrdersPerDayPerIp) {
      signals.push(
        signal(
          RiskSignal.DAILY_LIMIT_IP,
          `Daily limit reached — ${inDay} orders from this network in 24h`,
          weight(RiskSignal.DAILY_LIMIT_IP),
          { count: inDay, limit: settings.maxOrdersPerDayPerIp },
        ),
      );
    }
  }

  /*
   * The same limit, counted per browser.
   *
   * Off by default and deliberately so: a shared family tablet placing two
   * orders is ordinary, and a fingerprint is not an identity. It earns its keep
   * against someone cycling phone numbers from one machine, which is the case
   * the phone and IP counters both miss.
   */
  if (settings.checkDeviceVelocity && subject.deviceFingerprint) {
    const inDay = await repository.countByDevice(daily, subject.deviceFingerprint);

    if (inDay >= settings.maxOrdersPerDayPerDevice) {
      signals.push(
        signal(
          RiskSignal.DAILY_LIMIT_DEVICE,
          `Daily limit reached — ${inDay} orders from this browser in 24h`,
          weight(RiskSignal.DAILY_LIMIT_DEVICE),
          { count: inDay, limit: settings.maxOrdersPerDayPerDevice },
        ),
      );
    }
  }

  if (subject.email) {
    const inDay = await repository.countByEmail(daily, subject.email);

    if (inDay >= settings.maxOrdersPerDayPerEmail) {
      signals.push(
        signal(
          RiskSignal.DAILY_LIMIT_EMAIL,
          `Daily limit reached — ${inDay} orders from this email in 24h`,
          weight(RiskSignal.DAILY_LIMIT_EMAIL),
          { count: inDay, limit: settings.maxOrdersPerDayPerEmail },
        ),
      );
    }
  }

  return signals;
};

/**
 * The merchant's own delivery history for this customer.
 *
 * The most predictive signal available for COD, and the one no third-party
 * service can provide: somebody who has refused delivery here before is far
 * more likely to do it again.
 */
/**
 * A single order asking for an implausible number of units.
 *
 * The one detector here that needs no history: reselling and card-testing both
 * show up as one enormous basket, and a merchant who sells one item at a time
 * knows their own ceiling far better than any heuristic could infer it. Off
 * until they set it, because there is no sensible default — a wholesaler's
 * normal order is a fraud signal for a boutique.
 */
export const quantityDetector: Detector = async ({ subject, settings }) => {
  const limit = settings.maxItemsPerOrder;

  // Zero is off, not a limit of zero — a limit of zero would refuse everything.
  if (limit <= 0 || subject.itemQuantity <= limit) return [];

  return [
    signal(
      RiskSignal.EXCESSIVE_QUANTITY,
      `${subject.itemQuantity} items in one order — the limit is ${limit}`,
      weight(RiskSignal.EXCESSIVE_QUANTITY),
      { quantity: subject.itemQuantity, limit },
    ),
  ];
};

export const historyDetector: Detector = async ({ subject }) => {
  if (!subject.phoneE164) return [];

  const { cancelled, returned } = await repository.countPriorFailures(
    subject.shopId,
    subject.phoneE164,
    subject.codOrderId,
  );

  const signals: RiskSignalResult[] = [];

  if (cancelled > 0) {
    signals.push(
      signal(
        RiskSignal.PRIOR_CANCELLATIONS,
        `${cancelled} previously cancelled order${cancelled === 1 ? '' : 's'} from this customer`,
        Math.min(weight(RiskSignal.PRIOR_CANCELLATIONS) * cancelled, 60),
        { count: cancelled },
      ),
    );
  }

  if (returned > 0) {
    signals.push(
      signal(
        RiskSignal.PRIOR_RETURNS,
        `${returned} previously returned or refunded order${returned === 1 ? '' : 's'}`,
        Math.min(weight(RiskSignal.PRIOR_RETURNS) * returned, 60),
        { count: returned },
      ),
    );
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Identity quality
// ---------------------------------------------------------------------------

export const identityDetector: Detector = async ({ subject, settings }) => {
  const signals: RiskSignalResult[] = [];

  if (settings.checkDisposableEmail && subject.email && isDisposableEmailDomain(subject.email)) {
    signals.push(
      signal(
        RiskSignal.DISPOSABLE_EMAIL,
        'Throwaway email address',
        weight(RiskSignal.DISPOSABLE_EMAIL),
        { domain: subject.email.split('@')[1] ?? null },
      ),
    );
  }

  if (settings.checkFakePhone) {
    // An unparseable number never reaches here — form validation rejects it —
    // so this catches the structurally valid but obviously invented ones.
    if (!subject.phoneIsValid) {
      signals.push(
        signal(RiskSignal.FAKE_PHONE, 'Phone number is not valid for its country', weight(RiskSignal.FAKE_PHONE)),
      );
    } else if (subject.phoneE164 && looksFabricated(subject.phoneE164)) {
      signals.push(
        signal(RiskSignal.FAKE_PHONE, 'Phone number looks made up', weight(RiskSignal.FAKE_PHONE), {
          pattern: 'sequential-or-repeated',
        }),
      );
    }

    /**
     * A landline is worth a nudge rather than a penalty. Couriers need to
     * reach the customer on delivery and a landline is worse for that, but
     * plenty of legitimate COD customers in some markets have nothing else.
     */
    if (subject.phoneType && subject.phoneType !== 'MOBILE' && subject.phoneType !== 'FIXED_LINE_OR_MOBILE') {
      signals.push(
        signal(
          RiskSignal.PHONE_NOT_MOBILE,
          `Phone is a ${subject.phoneType.toLowerCase().replace(/_/g, ' ')} number`,
          weight(RiskSignal.PHONE_NOT_MOBILE),
          { type: subject.phoneType },
        ),
      );
    }
  }

  if (!subject.email) {
    // Barely scored. Many COD shoppers have no email, and the form makes it
    // optional for exactly that reason.
    signals.push(signal(RiskSignal.NO_EMAIL, 'No email address provided', weight(RiskSignal.NO_EMAIL)));
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * What the connection says about the shopper.
 *
 * Every branch checks `resolved` first: an unavailable provider produces no
 * signals rather than absent-means-suspicious. Tor carries the heaviest weight
 * of any inferred signal because, unlike a VPN, there is no ordinary reason to
 * place a cash-on-delivery order through it.
 */
export const networkDetector: Detector = async ({ subject, settings, ipIntel }) => {
  if (!ipIntel.resolved) return [];

  const signals: RiskSignalResult[] = [];

  if (settings.checkTor && ipIntel.isTor) {
    signals.push(signal(RiskSignal.IP_IS_TOR, 'Ordered over the Tor network', weight(RiskSignal.IP_IS_TOR)));
  }

  if (settings.checkVpn && ipIntel.isVpn) {
    signals.push(signal(RiskSignal.IP_IS_VPN, 'Ordered over a VPN', weight(RiskSignal.IP_IS_VPN)));
  }

  if (settings.checkProxy && ipIntel.isProxy) {
    signals.push(signal(RiskSignal.IP_IS_PROXY, 'Ordered over a proxy', weight(RiskSignal.IP_IS_PROXY)));
  }

  if (settings.checkProxy && ipIntel.isHosting) {
    // A shopper's browser does not normally run in a datacentre.
    signals.push(
      signal(RiskSignal.IP_IS_HOSTING, 'Ordered from a datacentre address', weight(RiskSignal.IP_IS_HOSTING)),
    );
  }

  if (settings.checkIpReputation && ipIntel.reputationScore !== null && ipIntel.reputationScore >= 75) {
    signals.push(
      signal(
        RiskSignal.IP_REPUTATION,
        `Address has a poor reputation (${ipIntel.reputationScore}/100)`,
        weight(RiskSignal.IP_REPUTATION),
        { score: ipIntel.reputationScore },
      ),
    );
  }

  /**
   * A delivery address in one country and a connection from another. Common and
   * innocent — travellers, expatriates, anyone on a VPN — so it is scored
   * lightly and only alongside everything else.
   */
  if (
    ipIntel.countryCode &&
    subject.countryCode &&
    ipIntel.countryCode.toUpperCase() !== subject.countryCode.toUpperCase()
  ) {
    signals.push(
      signal(
        RiskSignal.IP_COUNTRY_MISMATCH,
        `Connecting from ${ipIntel.countryCode}, delivering to ${subject.countryCode}`,
        weight(RiskSignal.IP_COUNTRY_MISMATCH),
        { ipCountry: ipIntel.countryCode, deliveryCountry: subject.countryCode },
      ),
    );
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export const geographyDetector: Detector = async ({ subject, settings }) => {
  if (!settings.checkCountryRisk) return [];
  if (!subject.countryCode) return [];

  const risky = settings.highRiskCountryCodes.map((code) => code.toUpperCase());

  if (!risky.includes(subject.countryCode.toUpperCase())) return [];

  return [
    signal(
      RiskSignal.HIGH_RISK_COUNTRY,
      `${subject.countryCode} is on your high-risk country list`,
      weight(RiskSignal.HIGH_RISK_COUNTRY),
      { countryCode: subject.countryCode },
    ),
  ];
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const DETECTORS: ReadonlyArray<{ name: string; run: Detector }> = [
  { name: 'blockList', run: blockListDetector },
  { name: 'duplicates', run: duplicateDetector },
  { name: 'velocity', run: velocityDetector },
  { name: 'quantity', run: quantityDetector },
  { name: 'history', run: historyDetector },
  { name: 'identity', run: identityDetector },
  { name: 'network', run: networkDetector },
  { name: 'geography', run: geographyDetector },
];

/**
 * Runs every detector, isolating failures.
 *
 * `allSettled`, not `all`: one detector hitting a database timeout must not
 * discard the signals the other six produced. A partial assessment is a usable
 * assessment; a failed one blocks checkout.
 */
export async function runDetectors(context: DetectorContext): Promise<RiskSignalResult[]> {
  const results = await Promise.allSettled(
    DETECTORS.map(async (detector) => ({
      name: detector.name,
      signals: await detector.run(context),
    })),
  );

  const signals: RiskSignalResult[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      signals.push(...result.value.signals);
      continue;
    }

    log.error(
      { err: toError(result.reason), detector: DETECTORS[index]?.name },
      'Fraud detector failed — continuing without its signals',
    );
  }

  return signals;
}

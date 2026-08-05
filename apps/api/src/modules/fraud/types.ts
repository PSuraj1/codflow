import type { FraudSettings } from '@prisma/client';
import type { RiskSignalResult } from '@codflow/shared';
import type { IpIntelResult } from '../../lib/ipIntel';

/**
 * The shape every detector works against.
 *
 * Deliberately *not* a `CodOrder`. The engine has to run before the order row
 * exists — a blocked submission should never become a record — and it also has
 * to run again later against a saved order during a rescan. A neutral input
 * type is what lets one implementation serve both.
 */
export interface FraudSubject {
  readonly shopId: string;
  readonly shopDomain: string;

  /** Excluded from its own duplicate and velocity counts on a rescan. */
  readonly codOrderId: string | null;

  readonly phone: string;
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly addressHash: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly province: string | null;
  readonly city: string | null;

  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceFingerprint: string | null;

  readonly total: number;
  readonly subtotal: number;
  readonly itemCount: number;
  /**
   * Combined quantity across every line, which is what a quantity limit means
   * to a merchant. `itemCount` is the number of *lines* — one line of forty
   * units is a single line and forty items.
   */
  readonly itemQuantity: number;
  readonly currency: string;

  readonly utmSource: string | null;
  readonly utmCampaign: string | null;

  /** Populated by the engine before rule evaluation, not by detectors. */
  readonly phoneIsValid: boolean;
  readonly phoneType: string | null;

  /**
   * The shopper refused automated risk *decisions* on this submission.
   *
   * Detectors ignore this — it changes what the verdict may be, not what the
   * signals say — so a merchant reviewing the order still sees everything the
   * engine found. See `engine.ts` for where it takes effect.
   */
  readonly profilingOptOut: boolean;
}

/**
 * Everything a detector may read.
 *
 * IP intelligence is resolved once by the engine and passed in, rather than
 * each detector looking it up — four detectors consume it and four lookups per
 * order would quadruple both the latency and the provider bill.
 */
export interface DetectorContext {
  readonly subject: FraudSubject;
  readonly settings: FraudSettings;
  readonly ipIntel: IpIntelResult;
  /** Wall clock, injectable so time-window tests are deterministic. */
  readonly now: Date;
}

/**
 * A detector returns the signals it raised, or an empty array.
 *
 * Returning rather than throwing is the contract that matters: a detector that
 * cannot answer — a database timeout, an absent field — must produce no signal
 * instead of failing the assessment. A fraud check that takes down checkout
 * when it breaks is worse than no fraud check.
 */
export type Detector = (context: DetectorContext) => Promise<RiskSignalResult[]>;

/** Builds a signal with the standard shape. */
export function signal(
  code: string,
  label: string,
  weight: number,
  detail?: Record<string, unknown>,
): RiskSignalResult {
  return { code, label, weight, matched: true, ...(detail ? { detail } : {}) };
}

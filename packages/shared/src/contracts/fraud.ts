import type { BlockListScope, BlockListType, RiskAction, RiskLevel } from '../enums.js';

/**
 * The fraud contract.
 *
 * COD is the only checkout where the merchant ships first and finds out
 * afterwards, so a wrong decision here has an asymmetric cost: a missed
 * fraudster loses one parcel, but a blocked real customer loses a sale *and*
 * gets told they look like a criminal. Every default in this file leans toward
 * letting the order through and flagging it, rather than refusing it.
 *
 * Signals are additive points on a 0–100 scale rather than a verdict each. No
 * single signal blocks an order on its own — a shared office IP, a family
 * reusing one phone, a returning customer at the same address are all ordinary.
 * It is the accumulation that means something.
 */

/**
 * Every signal the engine can raise.
 *
 * Stable codes: they are persisted in `RiskAssessment.signals` and rendered in
 * the admin, so renaming one silently breaks the display of historic
 * assessments.
 */
export const RiskSignal = {
  // ---- Lists the merchant curates
  BLACKLISTED_PHONE: 'BLACKLISTED_PHONE',
  BLACKLISTED_EMAIL: 'BLACKLISTED_EMAIL',
  BLACKLISTED_IP: 'BLACKLISTED_IP',
  BLACKLISTED_ADDRESS: 'BLACKLISTED_ADDRESS',
  BLACKLISTED_POSTAL_CODE: 'BLACKLISTED_POSTAL_CODE',
  BLACKLISTED_COUNTRY: 'BLACKLISTED_COUNTRY',
  BLACKLISTED_DEVICE: 'BLACKLISTED_DEVICE',

  // ---- Repetition
  DUPLICATE_PHONE: 'DUPLICATE_PHONE',
  DUPLICATE_EMAIL: 'DUPLICATE_EMAIL',
  DUPLICATE_ADDRESS: 'DUPLICATE_ADDRESS',

  // ---- Rate
  VELOCITY_PHONE: 'VELOCITY_PHONE',
  VELOCITY_IP: 'VELOCITY_IP',
  DAILY_LIMIT_PHONE: 'DAILY_LIMIT_PHONE',
  DAILY_LIMIT_IP: 'DAILY_LIMIT_IP',
  DAILY_LIMIT_EMAIL: 'DAILY_LIMIT_EMAIL',
  TOO_MANY_OPEN_ORDERS: 'TOO_MANY_OPEN_ORDERS',

  // ---- Identity quality
  DISPOSABLE_EMAIL: 'DISPOSABLE_EMAIL',
  FAKE_PHONE: 'FAKE_PHONE',
  PHONE_NOT_MOBILE: 'PHONE_NOT_MOBILE',
  NO_EMAIL: 'NO_EMAIL',

  // ---- Network
  IP_IS_VPN: 'IP_IS_VPN',
  IP_IS_PROXY: 'IP_IS_PROXY',
  IP_IS_TOR: 'IP_IS_TOR',
  IP_IS_HOSTING: 'IP_IS_HOSTING',
  IP_REPUTATION: 'IP_REPUTATION',
  IP_COUNTRY_MISMATCH: 'IP_COUNTRY_MISMATCH',

  // ---- Geography
  HIGH_RISK_COUNTRY: 'HIGH_RISK_COUNTRY',
  EXCESSIVE_QUANTITY: 'EXCESSIVE_QUANTITY',
  DAILY_LIMIT_DEVICE: 'DAILY_LIMIT_DEVICE',
  POSTAL_CODE_BLOCKED: 'POSTAL_CODE_BLOCKED',

  // ---- History
  PRIOR_CANCELLATIONS: 'PRIOR_CANCELLATIONS',
  PRIOR_RETURNS: 'PRIOR_RETURNS',

  // ---- Merchant-authored
  CUSTOM_RULE: 'CUSTOM_RULE',
} as const;

export type RiskSignal = (typeof RiskSignal)[keyof typeof RiskSignal];

/** One signal's contribution to an assessment. */
export interface RiskSignalResult {
  readonly code: RiskSignal | string;
  /** Merchant-facing explanation. Rendered verbatim in the risk breakdown. */
  readonly label: string;
  /** Points added. Negative for a whitelist, which is how trust is expressed. */
  readonly weight: number;
  readonly matched: boolean;
  /** Structured context — counts, matched values, provider answers. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Default weights.
 *
 * Calibrated so that no single signal reaches the default high threshold of 60
 * on its own, except the ones that represent an explicit merchant decision
 * (a blacklist entry) or a near-certain automation signal (Tor).
 *
 * The reasoning behind the low ones matters as much as the high ones:
 * `DUPLICATE_PHONE` is 18 rather than 40 because families share phones and
 * customers reorder; `NO_EMAIL` is 4 because plenty of legitimate COD shoppers
 * simply do not have one.
 */
export const DEFAULT_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  [RiskSignal.BLACKLISTED_PHONE]: 100,
  [RiskSignal.BLACKLISTED_EMAIL]: 100,
  [RiskSignal.BLACKLISTED_IP]: 100,
  [RiskSignal.BLACKLISTED_ADDRESS]: 100,
  [RiskSignal.BLACKLISTED_POSTAL_CODE]: 100,
  [RiskSignal.BLACKLISTED_COUNTRY]: 100,
  [RiskSignal.BLACKLISTED_DEVICE]: 100,

  [RiskSignal.DUPLICATE_PHONE]: 18,
  [RiskSignal.DUPLICATE_EMAIL]: 15,
  [RiskSignal.DUPLICATE_ADDRESS]: 12,

  [RiskSignal.VELOCITY_PHONE]: 30,
  [RiskSignal.VELOCITY_IP]: 25,
  [RiskSignal.DAILY_LIMIT_PHONE]: 35,
  [RiskSignal.DAILY_LIMIT_IP]: 30,
  [RiskSignal.DAILY_LIMIT_EMAIL]: 30,
  [RiskSignal.TOO_MANY_OPEN_ORDERS]: 25,
  [RiskSignal.DAILY_LIMIT_DEVICE]: 30,

  // Heavy, but not on its own decisive: a genuine bulk buyer exists, and a
  // merchant who wants a hard refusal sets the limit and blocks at CRITICAL.
  [RiskSignal.EXCESSIVE_QUANTITY]: 40,

  [RiskSignal.DISPOSABLE_EMAIL]: 35,
  [RiskSignal.FAKE_PHONE]: 45,
  [RiskSignal.PHONE_NOT_MOBILE]: 8,
  [RiskSignal.NO_EMAIL]: 4,

  [RiskSignal.IP_IS_VPN]: 25,
  [RiskSignal.IP_IS_PROXY]: 30,
  [RiskSignal.IP_IS_TOR]: 60,
  [RiskSignal.IP_IS_HOSTING]: 35,
  [RiskSignal.IP_REPUTATION]: 30,
  [RiskSignal.IP_COUNTRY_MISMATCH]: 15,

  [RiskSignal.HIGH_RISK_COUNTRY]: 20,
  [RiskSignal.POSTAL_CODE_BLOCKED]: 100,

  [RiskSignal.PRIOR_CANCELLATIONS]: 30,
  [RiskSignal.PRIOR_RETURNS]: 25,
};

/** A completed assessment, as the admin renders it. */
export interface RiskAssessmentSummary {
  readonly id: string;
  readonly score: number;
  readonly level: RiskLevel;
  readonly action: RiskAction;
  readonly signals: readonly RiskSignalResult[];
  readonly matchedRuleIds: readonly string[];
  readonly ipCountryCode: string | null;
  readonly ipIsVpn: boolean | null;
  readonly ipIsProxy: boolean | null;
  readonly ipIsTor: boolean | null;
  readonly ipIsHosting: boolean | null;
  readonly emailIsDisposable: boolean | null;
  readonly phoneIsValid: boolean | null;
  readonly reviewedAt: string | null;
  readonly reviewDecision: RiskAction | null;
  readonly reviewNote: string | null;
  readonly durationMs: number | null;
  readonly createdAt: string;
}

/** Merchant-facing fraud configuration. */
export interface FraudSettingsSummary {
  readonly isEnabled: boolean;
  readonly mediumThreshold: number;
  readonly highThreshold: number;
  readonly criticalThreshold: number;
  readonly actionOnMedium: RiskAction;
  readonly actionOnHigh: RiskAction;
  readonly actionOnCritical: RiskAction;

  readonly checkDuplicatePhone: boolean;
  readonly checkDuplicateEmail: boolean;
  readonly checkDuplicateAddress: boolean;
  readonly checkDisposableEmail: boolean;
  readonly checkFakePhone: boolean;
  readonly checkVpn: boolean;
  readonly checkProxy: boolean;
  readonly checkTor: boolean;
  readonly checkVelocity: boolean;
  readonly checkCountryRisk: boolean;
  readonly checkIpReputation: boolean;
  readonly checkBlockList: boolean;

  readonly maxOrdersPerDayPerPhone: number;
  readonly maxOrdersPerDayPerIp: number;
  readonly maxOrdersPerDayPerEmail: number;
  readonly maxOpenCodOrders: number;
  readonly velocityWindowMinutes: number;
  readonly velocityMaxOrders: number;
  readonly duplicateWindowHours: number;

  readonly highRiskCountryCodes: readonly string[];
  readonly maxItemsPerOrder: number;
  readonly checkDeviceVelocity: boolean;
  readonly maxOrdersPerDayPerDevice: number;
  /** Shown to a refused shopper. Null uses the generic wording. */
  readonly blockedMessage: string | null;

  readonly autoBlacklistAfterFailures: number;
  readonly tagHighRiskOrders: boolean;
  readonly highRiskTag: string;
  /** True when an IP intelligence provider is configured on this deployment. */
  readonly ipIntelAvailable: boolean;
}

export interface BlockListEntrySummary {
  readonly id: string;
  readonly type: BlockListType;
  readonly scope: BlockListScope;
  readonly value: string;
  readonly reason: string | null;
  readonly createdBy: string;
  readonly expiresAt: string | null;
  readonly isActive: boolean;
  readonly hitCount: number;
  readonly lastHitAt: string | null;
  readonly createdAt: string;
}

export interface FraudRuleSummary {
  readonly id: string;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly priority: number;
  readonly conditions: unknown;
  readonly scoreDelta: number;
  readonly action: RiskAction | null;
  readonly reason: string | null;
  readonly matchCount: number;
  readonly lastMatchedAt: string | null;
}

/** Fields a merchant rule may test. Mirrors what the engine exposes. */
export const RULE_FIELDS = [
  'total',
  'subtotal',
  'itemCount',
  'currency',
  'countryCode',
  'province',
  'city',
  'postalCode',
  'email',
  'phone',
  'riskScore',
  'ipCountryCode',
  'isNewCustomer',
  'hoursSinceLastOrder',
  'utmSource',
  'utmCampaign',
] as const;

export type RuleField = (typeof RULE_FIELDS)[number];

/** The engine's version, stamped on every assessment for auditability. */
export const FRAUD_ENGINE_VERSION = '1.0.0';

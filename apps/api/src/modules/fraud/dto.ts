import { z } from 'zod';

/**
 * Fraud configuration contracts.
 *
 * The thresholds are the part worth guarding. A merchant who saves
 * `high: 20, medium: 60` has inverted their own policy, and the engine would
 * then classify a score of 30 as HIGH — blocking ordinary orders with no
 * obvious cause. So the ordering is enforced here rather than left to the UI.
 */

const RISK_ACTIONS = ['ALLOW', 'REVIEW', 'CHALLENGE_OTP', 'BLOCK'] as const;

const BLOCK_SCOPES = [
  'PHONE',
  'EMAIL',
  'IP',
  'ADDRESS',
  'POSTAL_CODE',
  'COUNTRY',
  'CUSTOMER_ID',
  'DEVICE_FINGERPRINT',
] as const;

/** ISO 3166-1 alpha-2. */
const countryCode = z.string().length(2).regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());

export const UpdateFraudSettingsSchema = z
  .object({
    isEnabled: z.boolean().optional(),

    mediumThreshold: z.number().int().min(1).max(100).optional(),
    highThreshold: z.number().int().min(1).max(100).optional(),
    criticalThreshold: z.number().int().min(1).max(100).optional(),

    actionOnMedium: z.enum(RISK_ACTIONS).optional(),
    actionOnHigh: z.enum(RISK_ACTIONS).optional(),
    actionOnCritical: z.enum(RISK_ACTIONS).optional(),

    checkDuplicatePhone: z.boolean().optional(),
    checkDuplicateEmail: z.boolean().optional(),
    checkDuplicateAddress: z.boolean().optional(),
    checkDisposableEmail: z.boolean().optional(),
    checkFakePhone: z.boolean().optional(),
    checkVpn: z.boolean().optional(),
    checkProxy: z.boolean().optional(),
    checkTor: z.boolean().optional(),
    checkVelocity: z.boolean().optional(),
    checkCountryRisk: z.boolean().optional(),
    checkIpReputation: z.boolean().optional(),
    checkBlockList: z.boolean().optional(),

    // Upper bounds are generous but finite: a limit of zero would block every
    // order, and an unbounded one makes the check meaningless.
    maxOrdersPerDayPerPhone: z.number().int().min(1).max(1_000).optional(),
    maxOrdersPerDayPerIp: z.number().int().min(1).max(1_000).optional(),
    maxOrdersPerDayPerEmail: z.number().int().min(1).max(1_000).optional(),
    maxOpenCodOrders: z.number().int().min(1).max(1_000).optional(),
    velocityWindowMinutes: z.number().int().min(1).max(1_440).optional(),
    velocityMaxOrders: z.number().int().min(1).max(100).optional(),
    duplicateWindowHours: z.number().int().min(1).max(720).optional(),

    // 0 is off. A real ceiling is generous — wholesalers exist — but finite,
    // because an unbounded one makes the check meaningless.
    maxItemsPerOrder: z.number().int().min(0).max(10_000).optional(),
    checkDeviceVelocity: z.boolean().optional(),
    maxOrdersPerDayPerDevice: z.number().int().min(1).max(1_000).optional(),

    // Shown to a refused shopper, so it is length-capped and may be cleared.
    blockedMessage: z.string().trim().max(300).nullish(),

    highRiskCountryCodes: z.array(countryCode).max(250).optional(),

    // Zero disables auto-blacklisting, which is the default. Below three it
    // would fire on a customer who had two parcels lost by a courier.
    autoBlacklistAfterFailures: z.number().int().min(0).max(50).optional(),
    tagHighRiskOrders: z.boolean().optional(),
    highRiskTag: z.string().min(1).max(60).optional(),
  })
  .refine(
    (input) =>
      input.mediumThreshold === undefined ||
      input.highThreshold === undefined ||
      input.mediumThreshold < input.highThreshold,
    { message: 'The medium threshold must be lower than the high threshold', path: ['mediumThreshold'] },
  )
  .refine(
    (input) =>
      input.highThreshold === undefined ||
      input.criticalThreshold === undefined ||
      input.highThreshold < input.criticalThreshold,
    { message: 'The high threshold must be lower than the critical threshold', path: ['highThreshold'] },
  );

export type UpdateFraudSettingsInput = z.infer<typeof UpdateFraudSettingsSchema>;

export const AddBlockListEntrySchema = z.object({
  type: z.enum(['BLACKLIST', 'WHITELIST']),
  scope: z.enum(BLOCK_SCOPES),
  // Normalized server-side into the form the detectors look up by; a merchant
  // pasting `+91 98765 43210` must match a query for `+919876543210`.
  value: z.string().min(1).max(255),
  reason: z.string().max(500).optional(),
  expiresAt: z.iso.datetime().optional(),
});

export type AddBlockListEntryInput = z.infer<typeof AddBlockListEntrySchema>;

/**
 * Wholesale replacement of one list.
 *
 * A merchant maintaining a block list edits it as a *list* — they paste a
 * column out of a spreadsheet, or delete three lines from the middle. Adding
 * entries one request at a time makes that a thousand round trips and leaves
 * the list half-updated if any of them fails, so the whole set is sent and the
 * server reconciles.
 *
 * Empty is meaningful: it clears the list. That is why there is no `.min(1)`.
 */
export const BulkBlockListSchema = z.object({
  type: z.enum(['BLACKLIST', 'WHITELIST']),
  scope: z.enum(BLOCK_SCOPES),
  values: z.array(z.string().min(1).max(255)).max(10_000),
});

export type BulkBlockListInput = z.infer<typeof BulkBlockListSchema>;

export const BlockListQuerySchema = z.object({
  type: z.enum(['BLACKLIST', 'WHITELIST']).optional(),
  scope: z.enum(BLOCK_SCOPES).optional(),
  search: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export type BlockListQueryInput = z.infer<typeof BlockListQuerySchema>;

/**
 * A merchant rule's conditions.
 *
 * Structured rather than free text. A string expression would need a parser,
 * and a parser accepting merchant input that runs on the checkout path is a
 * liability — this shape can only express comparisons.
 */
const RuleConditionSchema = z.object({
  field: z.string().min(1).max(40),
  operator: z.enum([
    'equals',
    'not_equals',
    'contains',
    'not_contains',
    'in',
    'not_in',
    'gt',
    'lt',
    'gte',
    'lte',
    'is_empty',
    'is_not_empty',
  ]),
  value: z
    .union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(100)])
    .optional(),
});

const RuleConditionsSchema = z
  .object({
    all: z.array(RuleConditionSchema).max(20).optional(),
    any: z.array(RuleConditionSchema).max(20).optional(),
  })
  .refine(
    (input) => (input.all?.length ?? 0) + (input.any?.length ?? 0) > 0,
    // A rule with no conditions would match nothing (the evaluator refuses it),
    // so saving one is always a mistake worth reporting.
    { message: 'A rule needs at least one condition' },
  );

export const CreateFraudRuleSchema = z.object({
  name: z.string().min(1).max(120),
  isEnabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(1_000).default(100),
  conditions: RuleConditionsSchema,
  // Negative deltas are allowed so a merchant can express trust — "orders from
  // this campaign are safe" — not only suspicion.
  scoreDelta: z.number().int().min(-100).max(100).default(0),
  action: z.enum(RISK_ACTIONS).nullish(),
  reason: z.string().max(300).nullish(),
});

export type CreateFraudRuleInput = z.infer<typeof CreateFraudRuleSchema>;

export const UpdateFraudRuleSchema = CreateFraudRuleSchema.partial();
export type UpdateFraudRuleInput = z.infer<typeof UpdateFraudRuleSchema>;

export const ReviewAssessmentSchema = z.object({
  decision: z.enum(RISK_ACTIONS),
  note: z.string().max(1_000).optional(),
});

export type ReviewAssessmentInput = z.infer<typeof ReviewAssessmentSchema>;

export const IdParamSchema = z.object({ id: z.string().cuid() });

export const ReferenceParamSchema = z.object({
  reference: z.string().min(3).max(32).regex(/^[A-Z]{2}-[A-Z0-9]+$/),
});

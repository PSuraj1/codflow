import { z } from 'zod';
import { HONEYPOT_FIELD_NAME } from '@codflow/shared';

/**
 * COD order submission contract.
 *
 * The most exposed input surface in the app: posted by an anonymous shopper,
 * from a page the merchant does not control, on a domain the app does not
 * control. Everything here is bounded, and the omissions are as deliberate as
 * the inclusions.
 *
 * **There is no price field, and there never will be.** Line items carry a
 * variant id and a quantity; every amount is resolved from Shopify server-side
 * before the order is written. A `price` accepted here would let a shopper set
 * their own — and with COD the goods ship before anyone notices.
 */

const variantGid = z
  .string()
  .max(64)
  .regex(
    /^(\d+|gid:\/\/shopify\/ProductVariant\/\d+)$/,
    'Not a valid variant identifier',
  );

const lineItem = z.object({
  variantId: variantGid,
  // A COD order of 500 units is not a customer, it is an attack on the
  // merchant's inventory. The ceiling is generous for genuine bulk buyers.
  quantity: z.number().int().min(1).max(100),
});

/**
 * Field values from the merchant's configured form.
 *
 * Left as a loose record on purpose: the keys are whatever the merchant named
 * their fields, so no static schema can describe them. The shared validation
 * engine checks this against the actual form definition immediately after
 * parsing — that is where the real validation happens, and it is the same code
 * the shopper's browser ran.
 *
 * The bounds here exist only to stop an oversized payload reaching that engine.
 */
const formValues = z.record(
  z.string().max(64),
  z.union([
    z.string().max(2_000),
    z.number(),
    z.boolean(),
    z.array(z.string().max(500)).max(50),
    z.null(),
  ]),
);

/** Attribution captured for analytics and for the fraud engine's velocity checks. */
const attribution = z
  .object({
    referrer: z.string().max(1_000).optional(),
    landingPage: z.string().max(1_000).optional(),
    utmSource: z.string().max(200).optional(),
    utmMedium: z.string().max(200).optional(),
    utmCampaign: z.string().max(200).optional(),
    utmTerm: z.string().max(200).optional(),
    utmContent: z.string().max(200).optional(),
    /** Correlation ids for deduplicating server-side pixel events in Phase 6. */
    clientId: z.string().max(200).optional(),
    fbp: z.string().max(200).optional(),
    fbc: z.string().max(500).optional(),
    ttclid: z.string().max(500).optional(),
    gclid: z.string().max(500).optional(),
  })
  .default({});

/**
 * Consent flags.
 *
 * Default false throughout. A shopper who did not tick a box has not consented,
 * and defaulting to true would fire marketing pixels for people who declined —
 * which is the kind of thing that ends an app listing.
 */
const consent = z
  .object({
    marketing: z.boolean().default(false),
    analytics: z.boolean().default(false),
    saleOfData: z.boolean().default(false),
  })
  .default({ marketing: false, analytics: false, saleOfData: false });

export const SubmitOrderSchema = z.object({
  /** Issued with the form render; proves the submission followed a real render. */
  formToken: z.string().min(1).max(2_000),
  formId: z.string().cuid(),

  lineItems: z.array(lineItem).min(1).max(50),
  values: formValues,

  discountCode: z.string().max(64).optional(),
  locale: z.string().max(10).optional(),

  attribution,
  consent,

  /**
   * Honeypot. Named to look like a real field to a script scraping the DOM,
   * and hidden from humans with CSS. Anything in it means an automated fill.
   */
  [HONEYPOT_FIELD_NAME]: z.string().max(200).optional(),

  /** Device fingerprint from the storefront, used by the fraud engine. */
  fingerprint: z.string().max(200).optional(),

  /**
   * Tick-box add-ons the shopper accepted.
   *
   * Ids only. Every price is re-resolved from the database at submission, so
   * this can change *which* add-ons are charged and never what they cost — the
   * same rule the cart follows.
   */
  bumpIds: z.array(z.string().cuid()).max(10).default([]),

  /**
   * The shopper refuses automated risk *decisions* on this order.
   *
   * Separate from `consent` because it is a refusal, not a permission: the
   * three consent flags gate what may be *sent* to advertising platforms, while
   * this gates what the fraud engine may *decide* on its own. Defaults false,
   * like the consent flags — a shopper who did not ask has not asked.
   *
   * Required by Shopify's protected customer data rules, which oblige an app
   * scoring shoppers to offer them a way to refuse it. A merchant could already
   * switch scoring off or reverse a verdict; the shopper had no route of their
   * own.
   */
  profilingOptOut: z.boolean().default(false),
});

export type SubmitOrderInput = z.infer<typeof SubmitOrderSchema>;

export const FormQuerySchema = z.object({
  shop: z.string().max(255).optional(),
  locale: z.string().max(10).optional(),
});

export type FormQueryInput = z.infer<typeof FormQuerySchema>;

/** Normalizes a bare numeric variant id to a GID. */
export function toVariantGid(value: string): string {
  return value.startsWith('gid://') ? value : `gid://shopify/ProductVariant/${value}`;
}

/**
 * Order status poll.
 *
 * The token is required and does the real work — see `statusController` for why
 * the reference alone must never be enough to read an order's status.
 */
export const OrderStatusSchema = z.object({
  shop: z.string().min(3).max(255),
  reference: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[A-Z]{2}-[A-Z0-9]+$/, 'Not a valid order reference'),
  token: z.string().min(16).max(512),
});

export type OrderStatusInput = z.infer<typeof OrderStatusSchema>;

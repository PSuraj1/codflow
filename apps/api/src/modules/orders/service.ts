import { CodOrderStatus, Prisma, RiskAction } from '@prisma/client';
import {
  HONEYPOT_FIELD_NAME,
  USAGE_METRICS,
  checkBotSignals,
  localizeForm,
  validateForm,
  type FormDefinition,
  type FormValues,
  type Locale,
} from '@codflow/shared';
import { prisma } from '../../db/prisma';
import { createLogger } from '../../lib/logger';
import { stableHash } from '../../lib/crypto';
import { normalizePhone } from '../../lib/phone';
import { issueFormToken, tokenAgeSeconds, verifyFormToken } from '../../lib/formToken';
import { loadOfflineSession } from '../../shopify/sessionStorage';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../lib/errors';
import * as fraudService from '../fraud/service';
import * as upsellsService from '../upsells/service';
import { enqueueOrderPush } from '../../queue/queues';
import * as stats from '../analytics/stats';
import * as billing from '../billing/service';
import { checkUsage } from '../billing/limits';
import * as formsService from '../forms/service';
import { shouldEnqueue } from './gates';
import { issueOrderToken } from '../../lib/orderToken';
import * as repository from './repository';
import { nextReference } from './reference';
import { priceOrder, resolveLineItems, type PricingSettings } from './pricing';
import type { SubmitOrderInput } from './dto';

const log = createLogger('orders-service');

/**
 * The COD submission pipeline.
 *
 * Order of operations is the design. Each step is cheaper than the one after
 * it, and each one that can reject does so before anything expensive runs —
 * which matters because this endpoint is public and an attacker controls how
 * often it is called:
 *
 *   1. form token       signature check, no I/O
 *   2. bot signals      honeypot and fill duration, no I/O
 *   3. shop and form    two indexed reads
 *   4. field validation shared engine, no I/O
 *   5. phone            local parse
 *   6. duplicate check  one indexed read
 *   7. pricing          the only Shopify round trip
 *   8. persist
 *
 * Putting pricing before validation would mean a script posting garbage still
 * costs the merchant a Shopify API call per attempt, against a rate limit they
 * share with every other app on their store.
 */

/** Window in which an identical submission is treated as a double-tap. */
const DUPLICATE_WINDOW_SECONDS = 120;

export interface SubmissionContext {
  readonly shopDomain: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface SubmissionResult {
  readonly reference: string;
  readonly status: CodOrderStatus;
  readonly total: string;
  readonly currency: string;
  readonly successMessage: string;
  /** True when the shopper must still verify an OTP. Wired up in Phase 8. */
  readonly requiresOtp: boolean;
  /**
   * Lets this browser poll for the order's push status.
   *
   * The form uses it to hand the shopper to Shopify's own thank-you page once
   * the order exists there. Scoped to one shop and one reference, and
   * short-lived — see `lib/orderToken`.
   */
  readonly orderToken: string;
}

/**
 * Shop record the pipeline needs.
 *
 * Loaded in one query rather than through the storefront cache: an order is
 * written from this data, and a five-minute-old COD fee would charge the
 * shopper an amount the merchant has already changed.
 */
async function loadShopForSubmission(shopDomain: string) {
  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: {
      id: true,
      domain: true,
      isActive: true,
      currencyCode: true,
      countryCode: true,
      settings: {
        select: {
          codEnabled: true,
          codFeeEnabled: true,
          codFeeAmount: true,
          codFeeIsPercent: true,
          shippingFee: true,
          freeShippingAbove: true,
          minOrderValue: true,
          maxOrderValue: true,
          allowedCountryCodes: true,
          blockedCountryCodes: true,
        },
      },
    },
  });

  // Destructured so the null check narrows `settings` for every later use —
  // the pipeline reads it a dozen times and guarding at each one would bury the
  // logic.
  const settings = shop?.settings;

  if (!shop || !shop.isActive || !settings?.codEnabled) {
    // Deliberately vague. A shopper cannot act on "this merchant's plan
    // lapsed", and spelling out which condition failed tells a prober about the
    // merchant's account.
    throw new NotFoundError('Cash on delivery is not available for this store');
  }

  return { ...shop, settings };
}

/** Serves the active form for a storefront render, localized and token-bound. */
export async function getFormForStorefront(
  shopDomain: string,
  locale: string | undefined,
): Promise<{ form: FormDefinition; formToken: string; locale: Locale }> {
  const shop = await loadShopForSubmission(shopDomain);
  const form = await formsService.getActiveForm(shop.id);

  if (!form) {
    throw new NotFoundError('This store has no active cash-on-delivery form');
  }

  const language = (locale ?? 'en').split('-')[0]?.toLowerCase() ?? 'en';

  return {
    form: localizeForm(form, language),
    formToken: issueFormToken(shopDomain, form.id),
    locale: language.toUpperCase() as Locale,
  };
}

/**
 * The form-field key that offers the shopper the fraud-scoring opt-out.
 *
 * A merchant adds a `CONSENT` field with this key and the form builder renders
 * it like any other — no new field type, no new storefront control. The key is
 * what gives it meaning, in the same way `address1` means the address line
 * rather than a custom field that happens to be called that.
 */
export const PROFILING_OPT_OUT_KEY = 'profilingOptOut';

/**
 * Maps validated field values onto the order's own columns.
 *
 * Reads system fields by `key`, which is exactly why the form service refuses
 * to let a merchant rename or delete one. Anything that is not a system field
 * lands in `customFields`, keyed as the merchant named it — which is also the
 * key the Google Sheets column mapping will reference in Phase 5.
 */
function partitionValues(form: FormDefinition, values: FormValues) {
  const systemKeys = new Set([
    'firstName',
    'lastName',
    'email',
    'phone',
    'address1',
    'address2',
    'city',
    'province',
    'country',
    'postalCode',
    'orderNotes',
    // Has its own column. Listed here so a merchant who offers the opt-out as a
    // form field does not also get a copy of it in `customFields`, where it
    // would reach their Google Sheet as an unexplained extra column.
    PROFILING_OPT_OUT_KEY,
  ]);

  const custom: Record<string, unknown> = {};

  for (const field of form.fields) {
    if (systemKeys.has(field.key)) continue;
    if (values[field.key] === undefined) continue;
    custom[field.key] = values[field.key];
  }

  const text = (key: string): string | null => {
    const value = values[key];
    if (value === null || value === undefined) return null;
    const asText = String(value).trim();
    return asText.length > 0 ? asText : null;
  };

  /** A boolean form value. Anything that is not literally `true` is false. */
  const flag = (key: string): boolean => values[key] === true;

  return { custom, text, flag };
}

/**
 * Canonical address digest, for duplicate-address detection in the fraud
 * engine. Whitespace and case are normalized so `12 High St.` and
 * `12  high st.` collapse to the same value.
 */
function hashAddress(parts: Array<string | null>): string | null {
  const joined = parts
    .filter((part): part is string => Boolean(part))
    .join('|')
    .replace(/\s+/g, ' ')
    .trim();

  return joined.length > 0 ? stableHash(joined) : null;
}

export async function submitOrder(
  context: SubmissionContext,
  input: SubmitOrderInput,
): Promise<SubmissionResult> {
  // ---- 1. Form token
  const token = verifyFormToken(input.formToken, context.shopDomain);

  if (!token.valid || !token.payload) {
    log.warn({ shop: context.shopDomain, reason: token.reason }, 'Rejected form token');

    throw token.reason === 'expired'
      ? new BadRequestError('This form has expired. Refresh the page and try again.')
      : new BadRequestError('This order could not be verified. Refresh the page and try again.');
  }

  if (token.payload.formId !== input.formId) {
    throw new BadRequestError('This order could not be verified. Refresh the page and try again.');
  }

  const shop = await loadShopForSubmission(context.shopDomain);
  const form = await formsService.getForm(shop.id, input.formId);

  if (!form.active) {
    throw new ConflictError('This form is no longer accepting orders. Refresh the page.');
  }

  // ---- 2. Bot signals
  //
  // Fill duration comes from the *signed* token rather than a hidden input, so
  // a script cannot backdate it without breaking the signature.
  const botCheck = checkBotSignals(
    form,
    input[HONEYPOT_FIELD_NAME],
    Date.now() - tokenAgeSeconds(token.payload) * 1_000,
  );

  if (!botCheck.passed) {
    log.warn(
      { shop: context.shopDomain, reason: botCheck.reason, ip: context.ipAddress },
      'Submission rejected by bot heuristics',
    );

    // Deliberately generic. Telling a script which signal caught it is telling
    // it what to change.
    throw new BadRequestError('We could not process this order. Please try again.');
  }

  // ---- 2b. The shop's monthly COD allowance.
  //
  // Checked before any Shopify round trip and before anything is written, so a
  // shop at its cap costs nothing to refuse. The message the shopper sees is
  // deliberately neutral — they are not the audience for a plan limit, and
  // "this store has used up its free orders" is nobody's idea of a good
  // checkout. The merchant sees the real reason on their dashboard, where the
  // usage meter has been warning them since 80%.
  const allowance = await checkUsage(shop.id, USAGE_METRICS.COD_ORDERS);

  if (!allowance.allowed) {
    log.warn(
      { shop: context.shopDomain, used: allowance.used, limit: allowance.limit, plan: allowance.plan },
      'COD order refused — the shop has reached its monthly plan limit',
    );

    throw new ForbiddenError('Cash on delivery is temporarily unavailable.');
  }

  // ---- 3. Field validation, with the same engine the browser ran
  const validation = validateForm(form, input.values as FormValues);

  if (!validation.valid) {
    throw new ValidationError('Please check the highlighted fields', {
      details: { fields: validation.errorsByKey },
    });
  }

  const { custom, text, flag } = partitionValues(form, validation.values);

  /**
   * Either route counts, and neither overrides the other.
   *
   * The theme can send the flag directly, and a merchant can offer it as a
   * consent field on the form. `||` rather than a precedence rule because both
   * express the same refusal, and the safe reading of a disagreement is the one
   * that honours it.
   */
  const profilingOptOut = input.profilingOptOut || flag(PROFILING_OPT_OUT_KEY);

  // ---- 4. Phone
  const rawPhone = text('phone');

  if (!rawPhone) {
    // The form service guarantees phone is present, enabled and required, so
    // reaching here means that invariant was broken.
    throw new ValidationError('A phone number is required', {
      details: { fields: { phone: 'A phone number is required' } },
    });
  }

  const countryCode = text('country') ?? shop.countryCode;
  const phone = normalizePhone(rawPhone, countryCode);

  if (!phone.valid) {
    throw new ValidationError('Please check the highlighted fields', {
      details: { fields: { phone: 'Enter a valid phone number for your country.' } },
    });
  }

  // ---- 5. Country restrictions
  const settings = shop.settings;
  const resolvedCountry = phone.countryCode ?? countryCode ?? null;

  if (resolvedCountry) {
    if (settings.blockedCountryCodes.includes(resolvedCountry)) {
      throw new ValidationError('Cash on delivery is not available in your country.');
    }

    if (
      settings.allowedCountryCodes.length > 0 &&
      !settings.allowedCountryCodes.includes(resolvedCountry)
    ) {
      throw new ValidationError('Cash on delivery is not available in your country.');
    }
  }

  // ---- 6. Pricing. The only Shopify round trip, and the only source of prices.
  const session = await loadOfflineSession(context.shopDomain);

  if (!session) {
    // Without a session the app cannot verify prices, and accepting the order
    // would mean trusting the browser's. Refusing is the safe failure.
    log.error({ shop: context.shopDomain }, 'No offline session — cannot price a COD order');
    throw new ServiceUnavailableError(
      'We could not confirm pricing right now. Please try again shortly.',
    );
  }

  const lineItems = await resolveLineItems(session, input.lineItems, shop.currencyCode);

  const pricingSettings: PricingSettings = {
    codFeeEnabled: settings.codFeeEnabled,
    codFeeAmount: settings.codFeeAmount,
    codFeeIsPercent: settings.codFeeIsPercent,
    shippingFee: settings.shippingFee,
    freeShippingAbove: settings.freeShippingAbove,
    minOrderValue: settings.minOrderValue,
    maxOrderValue: settings.maxOrderValue,
  };

  /**
   * Add-ons are resolved before pricing, from the database rather than the
   * payload. The browser sends ids; the price charged is always the stored one.
   */
  const bumps = await upsellsService.resolveSelected(shop.id, input.bumpIds);

  const priced = priceOrder(lineItems, pricingSettings, shop.currencyCode, bumps.total);

  // Address parts are resolved here rather than at persistence because the
  // risk assessment below needs them — the duplicate-address detector works off
  // the same hash that is later written onto the order.
  const address1 = text('address1');
  const city = text('city');
  const province = text('province');
  const postalCode = text('postalCode');
  const addressHash = hashAddress([address1, city, province, postalCode, resolvedCountry]);
  const attribution = input.attribution;

  // ---- 6b. Risk.
  //
  // Positioned after pricing because merchant rules can test `total`, and
  // before persistence because a BLOCK must not leave an order row behind. The
  // engine is bounded by its own deadline and fails open, so this cannot hang
  // or reject a submission on its own failure.
  const riskSubject = {
    shopId: shop.id,
    shopDomain: context.shopDomain,
    // No order exists yet — the verdict decides whether one should.
    codOrderId: null,
    phone: rawPhone,
    phoneE164: phone.e164,
    email: text('email'),
    addressHash,
    postalCode,
    countryCode: resolvedCountry,
    province,
    city,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    deviceFingerprint: input.fingerprint ?? null,
    total: Number(priced.total),
    subtotal: Number(priced.subtotal),
    itemCount: priced.lineItems.length,
    itemQuantity: priced.lineItems.reduce((total, item) => total + item.quantity, 0),
    currency: shop.currencyCode,
    utmSource: attribution.utmSource ?? null,
    utmCampaign: attribution.utmCampaign ?? null,
    phoneIsValid: phone.valid,
    phoneType: phone.type,
    profilingOptOut,
  };

  const risk = await fraudService.assessAndRecord(riskSubject);

  if (risk.assessment.action === RiskAction.BLOCK) {
    log.warn(
      {
        shop: context.shopDomain,
        score: risk.assessment.score,
        signals: risk.assessment.signals.filter((entry) => entry.weight > 0).map((entry) => entry.code),
      },
      'Order blocked by the fraud engine',
    );

    // The merchant's own wording if they set one, and otherwise deliberately
    // generic. Either way the *reason* is never appended: naming the signal
    // would tell someone probing the form exactly which detail to change, and a
    // real customer caught by a false positive is no better served by being
    // told they look like a fraudster.
    const settings = await fraudService.getSettings(shop.id);

    throw new ForbiddenError(
      settings.blockedMessage?.trim() || 'We are unable to accept this order.',
    );
  }

  // ---- 7. Double-submission
  //
  // Checked after pricing because the comparison is on the resolved total —
  // matching on the request body would miss a retry that arrived through a
  // fresh page load with a different token.
  const duplicate = await repository.findRecentDuplicate(
    shop.id,
    rawPhone,
    priced.total,
    DUPLICATE_WINDOW_SECONDS,
  );

  if (duplicate) {
    log.info(
      { shop: context.shopDomain, reference: duplicate.reference },
      'Duplicate submission — returning the existing order',
    );

    // Returning success rather than an error: from the shopper's point of view
    // their order *was* placed, and an error would prompt a third attempt.
    return {
      reference: duplicate.reference,
      status: duplicate.status,
      total: duplicate.total.toString(),
      currency: duplicate.currency,
      successMessage: form.successMessage,
      requiresOtp: duplicate.status === CodOrderStatus.PENDING_OTP,
      orderToken: issueOrderToken(context.shopDomain, duplicate.reference),
    };
  }

  // ---- 8. Persist
  const reference = await nextReference();

  const order = await repository.createWithTimeline(
    {
      shopId: shop.id,
      reference,
      /**
       * The form's own OTP setting, or the engine demanding one. A REVIEW
       * verdict deliberately produces a CONFIRMED order — the customer's part
       * is finished and telling them otherwise would be wrong. It is the push
       * gate, reading `riskAction`, that holds it back from Shopify until the
       * merchant decides.
       */
      status:
        form.requireOtp || risk.assessment.action === RiskAction.CHALLENGE_OTP
          ? CodOrderStatus.PENDING_OTP
          : CodOrderStatus.CONFIRMED,

      firstName: text('firstName'),
      lastName: text('lastName'),
      email: text('email'),
      phone: rawPhone,
      phoneE164: phone.e164,

      address1,
      address2: text('address2'),
      city,
      province,
      country: text('country'),
      countryCode: resolvedCountry,
      postalCode,
      addressHash,
      orderNotes: text('orderNotes'),

      lineItems: priced.lineItems as unknown as Prisma.InputJsonValue,
      currency: shop.currencyCode,
      subtotal: priced.subtotal,
      shippingFee: priced.shippingFee,
      codFee: priced.codFee,
      discount: priced.discount,
      total: priced.total,
      discountCode: input.discountCode ?? null,

      customFields: custom as Prisma.InputJsonValue,

      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      referrer: attribution.referrer ?? null,
      landingPage: attribution.landingPage ?? null,
      utmSource: attribution.utmSource ?? null,
      utmMedium: attribution.utmMedium ?? null,
      utmCampaign: attribution.utmCampaign ?? null,
      utmTerm: attribution.utmTerm ?? null,
      utmContent: attribution.utmContent ?? null,
      deviceFingerprint: input.fingerprint ?? null,
      clientId: attribution.clientId ?? null,
      fbp: attribution.fbp ?? null,
      fbc: attribution.fbc ?? null,
      ttclid: attribution.ttclid ?? null,
      gclid: attribution.gclid ?? null,

      selectedBumps: bumps.selected as unknown as Prisma.InputJsonValue,
      bumpTotal: priced.bumpTotal,

      marketingConsent: input.consent.marketing,
      analyticsConsent: input.consent.analytics,
      saleOfDataConsent: input.consent.saleOfData,

      // Stored, not just applied. A rescan runs off the saved order, so without
      // this the shopper's refusal would hold for the submission and be
      // forgotten the first time a merchant edited a rule.
      profilingOptOut,

      otpRequired: form.requireOtp || risk.assessment.action === RiskAction.CHALLENGE_OTP,

      riskScore: risk.assessment.score,
      riskLevel: risk.assessment.level,
      riskAction: risk.assessment.action,
    },
    `Order placed from the ${form.name} form`,
  );

  // The assessment ran before the order had an id, so its audit row is
  // attached now. Not awaited for correctness — the verdict is already on the
  // order — but awaited for ordering, so a rescan cannot race it.
  await fraudService.persistAssessment(
    order.id,
    { ...riskSubject, codOrderId: order.id },
    risk.assessment,
  );

  if (risk.assessment.action !== RiskAction.ALLOW) {
    await repository.appendEvent(
      order.id,
      'risk.flagged',
      `Risk score ${risk.assessment.score} (${risk.assessment.level}) — ${risk.assessment.action}.`,
      'system',
      {
        score: risk.assessment.score,
        level: risk.assessment.level,
        action: risk.assessment.action,
        signals: risk.assessment.signals
          .filter((entry) => entry.weight !== 0)
          .map((entry) => ({ code: entry.code, label: entry.label, weight: entry.weight })),
      },
    );
  }

  log.info(
    {
      shop: context.shopDomain,
      reference: order.reference,
      total: order.total.toString(),
      items: priced.lineItems.length,
      riskScore: risk.assessment.score,
      riskAction: risk.assessment.action,
    },
    'COD order created',
  );

  // ---- 9. Hand off to the worker.
  //
  // Deliberately after the response payload is already determined, and
  // deliberately not awaited for its outcome: the order is durably stored, so a
  // queue that is down must not fail a submission the shopper already
  // completed. `enqueueOrderPush` swallows its own errors for the same reason.
  //
  // A held order — awaiting OTP or fraud review — is not enqueued at all. It is
  // enqueued later by whatever clears the hold, so it does not sit in the queue
  // burning retry attempts against a condition the queue cannot resolve.
  if (shouldEnqueue(order)) {
    await enqueueOrderPush({ codOrderId: order.id, shopDomain: context.shopDomain });
  }

  // ---- 10. Count it.
  //
  // Last, and unable to fail the submission: the recorder catches its own
  // errors, because a dashboard counter is rebuildable from this very order and
  // a lost sale is not. It runs after the enqueue so an analytics slowdown
  // cannot delay the push.
  await stats.recordOrderCreated(order);

  // ---- 11. Count it against the plan.
  //
  // After creation, not before: the allowance was checked at step 2b, and
  // incrementing there would charge a merchant for an order that then failed
  // validation or was refused by the fraud engine. The gap between the two is
  // a race a shop could in principle exploit by submitting concurrently at the
  // boundary, and the trade is deliberate — a handful of extra orders costs far
  // less than billing merchants for orders that were never placed.
  await billing.recordUsage(shop.id, USAGE_METRICS.COD_ORDERS);

  return {
    reference: order.reference,
    status: order.status,
    total: order.total.toString(),
    currency: order.currency,
    successMessage: form.successMessage,
    requiresOtp: form.requireOtp,
    /*
     * Lets this browser — and only this browser — poll for the order's status
     * so it can be handed to Shopify's own thank-you page once the push lands.
     * The reference alone is guessable and the status page carries the
     * customer's address, so the reference is never sufficient on its own.
     */
    orderToken: issueOrderToken(context.shopDomain, order.reference),
  };
}

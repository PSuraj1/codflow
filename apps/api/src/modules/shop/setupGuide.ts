import type { Session } from '@shopify/shopify-api';
import {
  SetupStepKey,
  SetupStepState,
  type SetupGuide,
  type SetupStep,
} from '@codflow/shared';
import { prisma } from '../../db/prisma';
import { EmbedStatus, readEmbedStatus, type EmbedReport } from '../../shopify/themeEmbed';

/**
 * Builds the setup guide.
 *
 * Every step is derived here and nothing is written back, which is the whole
 * design: a step that stops being true stops being ticked. The contract doc in
 * `packages/shared/src/contracts/setup.ts` explains why the stored
 * `onboardingStep` cursor is not used for this.
 *
 * The order is the order a merchant should work in, and it is not the order
 * they are most likely to get stuck in. Buttons and forms are seeded at install
 * so they open already complete — they are orientation, not work. The embed is
 * the step that actually costs merchants, so it sits directly above the switch
 * that makes the app live.
 */

/**
 * Everything the steps are derived from.
 *
 * Exported with `buildSteps` so the rules can be tested against plain values
 * rather than a database — the interesting cases here are combinations of shop
 * state, not queries.
 */
export interface Facts {
  readonly buttons: number;
  readonly forms: number;
  readonly codEnabled: boolean;
  readonly sheetsConnected: boolean;
  readonly pixels: number;
  readonly dismissed: boolean;
  readonly embed: EmbedReport;
}

async function gather(shopId: string, session: Session | null): Promise<Facts> {
  const [buttons, forms, settings, googleAccount, sheetConfig, pixels, shop, embed] =
    await Promise.all([
      prisma.buttonConfig.count({ where: { shopId } }),
      prisma.formConfig.count({ where: { shopId } }),
      prisma.shopSettings.findUnique({ where: { shopId }, select: { codEnabled: true } }),
      prisma.googleAccount.findUnique({
        where: { shopId },
        select: { isActive: true, revokedAt: true },
      }),
      prisma.sheetConfig.findFirst({ where: { shopId }, select: { id: true, isActive: true } }),
      prisma.pixel.count({ where: { shopId, isEnabled: true } }),
      prisma.shop.findUnique({ where: { id: shopId }, select: { onboardingCompletedAt: true } }),
      // Without a session there is no Admin API to ask, which is a failed check
      // rather than a failed step.
      session
        ? readEmbedStatus(session)
        : Promise.resolve<EmbedReport>({
            status: EmbedStatus.UNKNOWN,
            themeName: null,
            editorUrl: null,
          }),
    ]);

  return {
    buttons,
    forms,
    codEnabled: settings?.codEnabled ?? false,
    sheetsConnected: Boolean(
      googleAccount?.isActive && !googleAccount.revokedAt && sheetConfig?.isActive,
    ),
    pixels,
    dismissed: shop?.onboardingCompletedAt !== null,
    embed,
  };
}

/** The embed step, which is the only one with a non-obvious message per state. */
function embedStep(embed: EmbedReport): SetupStep {
  const onTheme = embed.themeName ? ` on “${embed.themeName}”` : '';

  const summary: Record<EmbedStatus, string> = {
    [EmbedStatus.ENABLED]: `The app embed is on${onTheme}, so your COD button can render.`,
    [EmbedStatus.DISABLED]: `The app embed was added${onTheme} but is switched off — nothing renders until you turn it back on.`,
    [EmbedStatus.ABSENT]: `The app embed is not enabled${onTheme}. Until it is, your COD button cannot appear anywhere on your storefront.`,
    // Never blame the merchant for a check the app could not run.
    [EmbedStatus.UNKNOWN]: 'Could not check your theme just now. Open the theme editor to confirm.',
  };

  const state =
    embed.status === EmbedStatus.ENABLED
      ? SetupStepState.DONE
      : embed.status === EmbedStatus.UNKNOWN
        ? SetupStepState.UNKNOWN
        : SetupStepState.TODO;

  return {
    key: SetupStepKey.EMBED,
    title: 'Enable the app embed in your theme',
    state,
    summary: summary[embed.status],
    optional: false,
    actionPath: null,
    // Leaves the app entirely — the theme editor is Shopify's, not ours.
    actionUrl: embed.editorUrl,
    actionLabel: state === SetupStepState.DONE ? null : 'Open theme editor',
  };
}

export function buildSteps(facts: Facts): SetupStep[] {
  return [
    {
      key: SetupStepKey.BUTTON,
      title: 'Add your cash-on-delivery button',
      state: facts.buttons > 0 ? SetupStepState.DONE : SetupStepState.TODO,
      summary:
        facts.buttons > 0
          ? 'Your COD button is configured and ready to place.'
          : 'No button configured yet.',
      optional: false,
      actionPath: '/buttons',
      actionUrl: null,
      actionLabel: facts.buttons > 0 ? 'Customize' : 'Set it up',
    },
    {
      key: SetupStepKey.FORM,
      title: 'Review your order form',
      state: facts.forms > 0 ? SetupStepState.DONE : SetupStepState.TODO,
      summary:
        facts.forms > 0
          ? 'A default form is ready. Change the fields shoppers fill in at any time.'
          : 'No order form configured yet.',
      optional: false,
      actionPath: '/forms',
      actionUrl: null,
      actionLabel: facts.forms > 0 ? 'Review' : 'Set it up',
    },
    embedStep(facts.embed),
    {
      key: SetupStepKey.COD_LIVE,
      title: 'Turn cash on delivery on',
      state: facts.codEnabled ? SetupStepState.DONE : SetupStepState.TODO,
      summary: facts.codEnabled
        ? 'COD is live on your storefront.'
        : 'COD is switched off — shoppers see your normal checkout.',
      optional: false,
      actionPath: '/settings/visibility',
      actionUrl: null,
      actionLabel: facts.codEnabled ? null : 'Turn it on',
    },
    {
      key: SetupStepKey.SHEETS,
      title: 'Send orders to Google Sheets',
      state: facts.sheetsConnected ? SetupStepState.DONE : SetupStepState.TODO,
      summary: facts.sheetsConnected
        ? 'New orders are exported to your sheet automatically.'
        : 'Optional. Give your fulfilment team a live sheet of every COD order.',
      optional: true,
      actionPath: '/settings/sheets',
      actionUrl: null,
      actionLabel: facts.sheetsConnected ? 'Manage' : 'Connect',
    },
    {
      key: SetupStepKey.PIXELS,
      title: 'Report conversions to your ad platforms',
      state: facts.pixels > 0 ? SetupStepState.DONE : SetupStepState.TODO,
      summary:
        facts.pixels > 0
          ? `${facts.pixels} pixel${facts.pixels === 1 ? '' : 's'} configured.`
          : 'Optional. COD orders skip Shopify checkout, so ad platforms never see them unless you connect a pixel.',
      optional: true,
      actionPath: '/settings/pixels',
      actionUrl: null,
      actionLabel: facts.pixels > 0 ? 'Manage' : 'Set it up',
    },
  ];
}

/**
 * Counts progress across the required steps.
 *
 * `UNKNOWN` counts as not done for the total but must not make the guide look
 * finished — a merchant whose embed check failed is not "3 of 3".
 */
export function summarize(steps: readonly SetupStep[], dismissed: boolean): SetupGuide {
  const required = steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.state === SetupStepState.DONE);

  return {
    steps,
    requiredTotal: required.length,
    requiredDone: done.length,
    complete: done.length === required.length,
    dismissed,
  };
}

export async function build(shopId: string, session: Session | null): Promise<SetupGuide> {
  const facts = await gather(shopId, session);
  return summarize(buildSteps(facts), facts.dismissed);
}

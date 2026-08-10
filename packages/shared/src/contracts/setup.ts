/**
 * The setup guide.
 *
 * Two things shape this contract, and both are reactions to how the previous
 * attempt was modelled.
 *
 * **State is derived, never stored.** `Shop.onboardingStep` is an integer
 * cursor, which assumes setup only moves forwards. It does not: a merchant who
 * switches theme loses the app embed, and a stored counter would still claim
 * that step was finished while the storefront silently renders nothing. Every
 * step here is recomputed from live state on each read, so a step that breaks
 * un-completes itself. The stored columns are used for one thing only —
 * remembering that the card was dismissed.
 *
 * **Optional steps do not gate completion.** Sheets and pixels are real
 * features but not required to take a COD order, and counting them would leave
 * every merchant permanently at "4 of 6". `requiredDone / requiredTotal` counts
 * only what is needed to go live; the optional steps stay visible underneath.
 */

/** Identifies a step across the API, the UI and its tests. */
export const SetupStepKey = {
  BUTTON: 'BUTTON',
  FORM: 'FORM',
  EMBED: 'EMBED',
  COD_LIVE: 'COD_LIVE',
  SHEETS: 'SHEETS',
  PIXELS: 'PIXELS',
} as const;

export type SetupStepKey = (typeof SetupStepKey)[keyof typeof SetupStepKey];

/**
 * Whether a step is finished.
 *
 * `UNKNOWN` is deliberate and distinct from `TODO`. Detecting the app embed
 * requires an Admin API call that can fail for reasons unrelated to the
 * merchant — an expired token, a Shopify outage, a theme the app cannot read.
 * Reporting that as "not done" would tell a merchant who has correctly enabled
 * the embed that they have not, and send them to fix something that is not
 * broken. The UI shows it as "could not check" instead.
 */
export const SetupStepState = {
  DONE: 'DONE',
  TODO: 'TODO',
  UNKNOWN: 'UNKNOWN',
} as const;

export type SetupStepState = (typeof SetupStepState)[keyof typeof SetupStepState];

export interface SetupStep {
  readonly key: SetupStepKey;
  readonly title: string;
  readonly state: SetupStepState;
  /** Why the step is in this state, in the merchant's terms. */
  readonly summary: string;
  /** Excluded from `requiredTotal`; shown but never blocking. */
  readonly optional: boolean;
  /** In-app route the action button navigates to. Null when the action leaves the app. */
  readonly actionPath: string | null;
  /**
   * Absolute URL opened in the top frame instead of `actionPath` — the theme
   * editor, which lives in the Shopify admin rather than in this app.
   */
  readonly actionUrl: string | null;
  readonly actionLabel: string | null;
}

export interface SetupGuide {
  readonly steps: readonly SetupStep[];
  /** Required steps only. */
  readonly requiredTotal: number;
  readonly requiredDone: number;
  /** True once every required step is DONE. Optional steps are ignored. */
  readonly complete: boolean;
  /** The merchant hid the card. It stays hidden even if a step later regresses. */
  readonly dismissed: boolean;
}

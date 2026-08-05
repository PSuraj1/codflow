/**
 * Settings backup and transfer.
 *
 * One file that carries a shop's whole configuration, so a merchant can keep a
 * backup before a risky change and stand up a second store without redoing
 * every screen by hand.
 *
 * Two rules govern what may travel in it, and both are about what is
 * *deliberately absent*:
 *
 *  1. **No secrets.** Google and advertising-platform tokens, and the IP
 *     intelligence API key, are encrypted at rest precisely so they never leave
 *     the database. A backup file lands in a merchant's Downloads folder, gets
 *     emailed to a developer, and ends up in a support ticket — it is the last
 *     place a credential should be. Pixels and Sheets are therefore omitted
 *     whole rather than exported half-configured.
 *  2. **No personal data.** Orders are not settings. Neither is the fraud block
 *     list, which is a list of real shoppers' phone numbers and email
 *     addresses; exporting it would turn a configuration backup into a file of
 *     personal data, with none of the handling that implies.
 *
 * What remains is merchant-authored configuration, which is what a merchant
 * means by "my settings".
 */

/**
 * Bumped when the shape changes incompatibly.
 *
 * Import refuses a version it does not recognise rather than guessing. A
 * partially-understood settings file is worse than a rejected one: the merchant
 * ends up with some screens restored and some silently left alone, and no way
 * to tell which.
 */
export const SETTINGS_EXPORT_VERSION = 1;

/** What a settings file is allowed to contain. */
export interface SettingsExport {
  readonly version: number;
  readonly exportedAt: string;
  /**
   * The store the file came from. Recorded so a merchant can tell two backups
   * apart, and shown on import — never applied. The importing shop is always
   * the authenticated one.
   */
  readonly shopDomain: string;

  readonly settings: Record<string, unknown>;
  readonly buttons: readonly Record<string, unknown>[];
  readonly forms: readonly Record<string, unknown>[];
  readonly fraud: Record<string, unknown> | null;
  readonly fraudRules: readonly Record<string, unknown>[];
}

/** What an import actually changed, for the confirmation the merchant sees. */
export interface SettingsImportResult {
  readonly settings: boolean;
  readonly buttons: number;
  readonly forms: number;
  readonly fraud: boolean;
  readonly fraudRules: number;
  /**
   * Parts of the file that were understood but deliberately not applied, and
   * why. Surfaced rather than logged: a merchant who imported a file from
   * another store needs to know their product-specific rules did not come with
   * it, and silence would let them assume otherwise.
   */
  readonly skipped: readonly string[];
}

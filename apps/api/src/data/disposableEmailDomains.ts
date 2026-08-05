/**
 * Disposable email domains.
 *
 * A curated list rather than a fetched feed, deliberately. This check runs on
 * the order submission path, so a network lookup would add latency to every
 * COD order and fail open on every outage — and a fraud check that silently
 * stops working is worse than one that is slightly out of date.
 *
 * The list is intentionally conservative. A false positive here charges a real
 * customer a risk penalty for using a privacy-conscious mail provider, so
 * anything ambiguous is left off: Proton, Tutanota, Fastmail and similar are
 * *not* disposable, they are simply not Gmail.
 *
 * Weighted at 35 points rather than an outright block, because a disposable
 * address on a COD order is a signal and not a verdict — some shoppers use one
 * for every purchase, fraudulent or not.
 */

const DOMAINS = [
  // ---- The large, well-known throwaway services
  '0-mail.com',
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  '33mail.com',
  'anonbox.net',
  'anonymbox.com',
  'byom.de',
  'cool.fr.nf',
  'courriel.fr.nf',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'emailtemporanea.com',
  'emailtemporar.ro',
  'fakeinbox.com',
  'fakemail.net',
  'fakemailgenerator.com',
  'filzmail.com',
  'get2mail.fr',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'inboxalias.com',
  'inboxbear.com',
  'incognitomail.com',
  'jetable.fr.nf',
  'jetable.net',
  'jetable.org',
  'mail-temporaire.fr',
  'mail.tm',
  'mail7.io',
  'mailbox52.ga',
  'mailcatch.com',
  'maildrop.cc',
  'maildu.de',
  'mailexpire.com',
  'mailforspam.com',
  'mailinator.com',
  'mailinator.net',
  'mailinator.org',
  'mailnesia.com',
  'mailnull.com',
  'mailsac.com',
  'mailtemp.info',
  'mailtothis.com',
  'meltmail.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mt2015.com',
  'mytemp.email',
  'mytrashmail.com',
  'nowmymail.com',
  'nwytg.net',
  'objectmail.com',
  'oneoffmail.com',
  'pookmail.com',
  'proxymail.eu',
  'rcpt.at',
  'rtrtr.com',
  'safetymail.info',
  'sharklasers.com',
  'shitmail.me',
  'sofimail.com',
  'sogetthis.com',
  'spam4.me',
  'spamavert.com',
  'spambog.com',
  'spambox.us',
  'spamdecoy.net',
  'spamfree24.org',
  'spamgourmet.com',
  'spamherelots.com',
  'spamhole.com',
  'spaml.de',
  'spamspot.com',
  'superrito.com',
  'tempail.com',
  'tempemail.net',
  'tempinbox.com',
  'tempmail.de',
  'tempmail.net',
  'tempmail.plus',
  'tempmailer.com',
  'tempmailo.com',
  'temp-mail.io',
  'temp-mail.org',
  'temp-mail.ru',
  'tempr.email',
  'throwawaymail.com',
  'tmail.ws',
  'tmailinator.com',
  'trash-mail.at',
  'trash-mail.com',
  'trash-mail.de',
  'trashmail.com',
  'trashmail.de',
  'trashmail.me',
  'trashmail.net',
  'trashmail.org',
  'trbvm.com',
  'trialmail.de',
  'tyldd.com',
  'wegwerfmail.de',
  'wegwerfmail.net',
  'wegwerfmail.org',
  'wh4f.org',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'zetmail.com',

  // ---- Common in COD markets specifically
  'grr.la',
  'pokemail.net',
  'spam.la',
  'tempmail.altmails.com',
  'vusra.com',
  'zzz.com',
] as const;

const DOMAIN_SET = new Set<string>(DOMAINS);

/**
 * Suffixes covering services that hand out unlimited subdomains.
 *
 * `mailinator.com` alone misses `alice.mailinator.com`, which resolves to the
 * same public inbox.
 */
const DISPOSABLE_SUFFIXES = [
  '.mailinator.com',
  '.trashmail.com',
  '.yopmail.com',
  '.33mail.com',
  '.dropmail.me',
] as const;

/** True when an address belongs to a known throwaway provider. */
export function isDisposableEmailDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;

  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.length === 0) return false;

  if (DOMAIN_SET.has(domain)) return true;

  return DISPOSABLE_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

/** Exposed for the admin's diagnostics screen. */
export const DISPOSABLE_DOMAIN_COUNT = DOMAIN_SET.size;

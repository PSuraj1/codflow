import { describe, expect, it } from 'vitest';
import { isDisposableEmailDomain } from './disposableEmailDomains';

/**
 * Disposable email detection.
 *
 * The false-positive cases matter more than the true positives here. Flagging a
 * privacy-conscious customer's Proton address charges them a 35-point risk
 * penalty for not using Gmail, and on a COD form that can be the difference
 * between an order and a rejection.
 */

describe('known throwaway providers', () => {
  it.each([
    'a@mailinator.com',
    'a@guerrillamail.com',
    'a@10minutemail.com',
    'a@yopmail.com',
    'a@temp-mail.org',
    'a@trashmail.com',
    'a@sharklasers.com',
    'a@dropmail.me',
  ])('flags %s', (email) => {
    expect(isDisposableEmailDomain(email)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isDisposableEmailDomain('A@MAILINATOR.COM')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isDisposableEmailDomain('a@ mailinator.com ')).toBe(true);
  });

  /**
   * Several of these services hand out unlimited subdomains, all resolving to
   * the same public inbox — matching the bare domain alone would miss them.
   */
  it.each([
    'a@alice.mailinator.com',
    'a@anything.trashmail.com',
    'a@x.yopmail.com',
  ])('flags the subdomain form %s', (email) => {
    expect(isDisposableEmailDomain(email)).toBe(true);
  });
});

describe('legitimate providers', () => {
  it.each([
    'a@gmail.com',
    'a@outlook.com',
    'a@yahoo.com',
    'a@icloud.com',
    'a@hotmail.com',
    'a@rediffmail.com',
    'a@company.co.in',
  ])('does not flag %s', (email) => {
    expect(isDisposableEmailDomain(email)).toBe(false);
  });

  /**
   * Explicitly not disposable. These are privacy-focused mail providers with
   * real, persistent inboxes — a customer using one is not signalling anything
   * about their intent.
   */
  it.each([
    'a@proton.me',
    'a@protonmail.com',
    'a@tutanota.com',
    'a@fastmail.com',
    'a@hey.com',
  ])('does not flag the privacy provider %s', (email) => {
    expect(isDisposableEmailDomain(email)).toBe(false);
  });

  /**
   * A domain that merely *contains* a listed one must not match. Otherwise
   * `notmailinator.com` and `mailinator.com.example.co` would both be flagged.
   */
  it.each(['a@notmailinator.com', 'a@mailinator.com.example.co', 'a@my-yopmail.net'])(
    'does not flag the lookalike %s',
    (email) => {
      expect(isDisposableEmailDomain(email)).toBe(false);
    },
  );
});

describe('malformed input', () => {
  it.each([['no at sign', 'not-an-email'], ['empty', ''], ['trailing at', 'a@'], ['bare at', '@']])(
    'returns false for %s',
    (_label, email) => {
      expect(isDisposableEmailDomain(email)).toBe(false);
    },
  );

  it('uses the last @ so a plus-addressed local part cannot spoof the domain', () => {
    expect(isDisposableEmailDomain('a@gmail.com@mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('a@mailinator.com@gmail.com')).toBe(false);
  });
});

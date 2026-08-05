import { describe, expect, it, vi } from 'vitest';

/**
 * How a stuck order is grouped.
 *
 * The three predicates have to partition the stuck set exactly. An order in two
 * groups is counted twice and retried twice; an order in none disappears from a
 * screen whose whole job is to make sure nothing disappears — and neither shows
 * up as an error anywhere.
 *
 * Evaluating Prisma's `where` shapes in memory is what makes that testable
 * without a database. The interpreter below covers only the operators these
 * three predicates use; it is not a general one, and it fails loudly rather
 * than guessing if a predicate grows an operator it does not know.
 */

vi.mock('../../db/prisma', () => ({ prisma: {} }));

const { failingWhere, heldWhere, waitingWhere } = await import('./repository');

interface Order {
  status: string;
  pushAttempts: number;
  riskAction: string;
  otpRequired: boolean;
  otpVerified: boolean;
}

/** Evaluates the subset of Prisma's `where` grammar these predicates use. */
function matches(where: Record<string, unknown>, order: Order): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'NOT') return !matches(condition as Record<string, unknown>, order);
    if (key === 'OR') {
      return (condition as Record<string, unknown>[]).some((entry) => matches(entry, order));
    }
    if (key === 'AND') {
      return (condition as Record<string, unknown>[]).every((entry) => matches(entry, order));
    }

    const value = order[key as keyof Order];

    if (condition !== null && typeof condition === 'object') {
      const operators = condition as Record<string, unknown>;

      if ('in' in operators) return (operators.in as unknown[]).includes(value);
      if ('not' in operators) return value !== operators.not;
      if ('gt' in operators) return (value as number) > (operators.gt as number);

      throw new Error(`Unhandled operator in test interpreter: ${Object.keys(operators).join()}`);
    }

    return value === condition;
  });
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    status: 'CONFIRMED',
    pushAttempts: 0,
    riskAction: 'ALLOW',
    otpRequired: false,
    otpVerified: false,
    ...overrides,
  };
}

/** Every shape a stuck order can take, across the fields the groups read. */
const EVERY_STUCK_ORDER: Order[] = ['CONFIRMED', 'FAILED', 'PENDING_OTP'].flatMap((status) =>
  [0, 3].flatMap((pushAttempts) =>
    ['ALLOW', 'REVIEW', 'CHALLENGE_OTP'].flatMap((riskAction) =>
      [true, false].flatMap((otpRequired) =>
        [true, false].map((otpVerified) =>
          order({ status, pushAttempts, riskAction, otpRequired, otpVerified }),
        ),
      ),
    ),
  ),
);

describe('the three groups partition every stuck order', () => {
  it('puts each one in exactly one group', () => {
    for (const subject of EVERY_STUCK_ORDER) {
      const hits = [
        matches(failingWhere() as Record<string, unknown>, subject),
        matches(heldWhere() as Record<string, unknown>, subject),
        matches(waitingWhere() as Record<string, unknown>, subject),
      ].filter(Boolean).length;

      expect({ subject, hits }).toMatchObject({ hits: 1 });
    }
  });
});

describe('held', () => {
  it('covers an order in fraud review', () => {
    expect(matches(heldWhere() as Record<string, unknown>, order({ riskAction: 'REVIEW' }))).toBe(
      true,
    );
  });

  it('covers an order waiting on phone verification', () => {
    expect(
      matches(
        heldWhere() as Record<string, unknown>,
        order({ otpRequired: true, otpVerified: false }),
      ),
    ).toBe(true);
  });

  it('releases an order once the phone is verified', () => {
    expect(
      matches(
        heldWhere() as Record<string, unknown>,
        order({ otpRequired: true, otpVerified: true }),
      ),
    ).toBe(false);
  });
});

describe('failing', () => {
  it('covers a FAILED order', () => {
    expect(matches(failingWhere() as Record<string, unknown>, order({ status: 'FAILED' }))).toBe(
      true,
    );
  });

  /**
   * The case that started this: the status column only reaches FAILED on some
   * paths, so an order can sit at CONFIRMED with attempts behind it.
   */
  it('covers a CONFIRMED order that has been attempted', () => {
    expect(matches(failingWhere() as Record<string, unknown>, order({ pushAttempts: 5 }))).toBe(
      true,
    );
  });

  /** A held order is not failing, however many times it has been looked at. */
  it('excludes a held order with attempts behind it', () => {
    expect(
      matches(
        failingWhere() as Record<string, unknown>,
        order({ pushAttempts: 5, riskAction: 'REVIEW' }),
      ),
    ).toBe(false);
  });
});

describe('waiting', () => {
  it('covers a fresh confirmed order', () => {
    expect(matches(waitingWhere() as Record<string, unknown>, order())).toBe(true);
  });

  it('excludes one that has already been attempted', () => {
    expect(matches(waitingWhere() as Record<string, unknown>, order({ pushAttempts: 1 }))).toBe(
      false,
    );
  });
});

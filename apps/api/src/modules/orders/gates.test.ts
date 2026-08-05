import type { CodOrder } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { GateDecision, evaluateGates, shouldEnqueue } from './gates';

/**
 * Push gates.
 *
 * The seam later phases attach to: they *read* `riskAction` and `otpVerified`
 * off the order rather than computing them, so the fraud engine and OTP flow
 * land by populating columns that already exist. These tests pin the contract
 * both will rely on — including the precedence, which is what stops a cancelled
 * order from reporting as "waiting for verification".
 */

function order(overrides: Partial<CodOrder> = {}): CodOrder {
  return {
    id: 'order-1',
    status: 'CONFIRMED',
    shopifyOrderGid: null,
    riskAction: 'ALLOW',
    riskScore: 0,
    otpRequired: false,
    otpVerified: false,
    ...overrides,
  } as CodOrder;
}

describe('evaluateGates', () => {
  it('allows a clean order', () => {
    expect(evaluateGates(order()).decision).toBe(GateDecision.ALLOW);
  });

  describe('terminal states', () => {
    it('blocks a cancelled order', () => {
      const result = evaluateGates(order({ status: 'CANCELLED' }));
      expect(result.decision).toBe(GateDecision.BLOCK);
      expect(result.code).toBe('ORDER_CANCELLED');
    });

    /**
     * The one that matters most: a stale retry must never create a second
     * Shopify order, because the merchant discovers it by shipping both.
     */
    it('blocks an order already in Shopify', () => {
      const result = evaluateGates(order({ shopifyOrderGid: 'gid://shopify/Order/1' }));
      expect(result.decision).toBe(GateDecision.BLOCK);
      expect(result.code).toBe('ALREADY_PUSHED');
    });
  });

  describe('risk', () => {
    it('blocks a BLOCK action', () => {
      expect(evaluateGates(order({ riskAction: 'BLOCK', riskScore: 92 })).decision).toBe(
        GateDecision.BLOCK,
      );
    });

    it('holds a REVIEW action', () => {
      const result = evaluateGates(order({ riskAction: 'REVIEW', riskScore: 45 }));
      expect(result.decision).toBe(GateDecision.HOLD);
      expect(result.code).toBe('AWAITING_REVIEW');
    });

    it('surfaces the score in the merchant-facing reason', () => {
      expect(evaluateGates(order({ riskAction: 'REVIEW', riskScore: 45 })).reason).toContain('45');
    });
  });

  describe('OTP', () => {
    it('holds an unverified order that requires OTP', () => {
      const result = evaluateGates(order({ otpRequired: true }));
      expect(result.decision).toBe(GateDecision.HOLD);
      expect(result.code).toBe('AWAITING_OTP');
    });

    it('allows once verified', () => {
      expect(evaluateGates(order({ otpRequired: true, otpVerified: true })).decision).toBe(
        GateDecision.ALLOW,
      );
    });

    it('holds a CHALLENGE_OTP order until verified', () => {
      expect(evaluateGates(order({ riskAction: 'CHALLENGE_OTP' })).code).toBe('AWAITING_OTP');
      expect(
        evaluateGates(order({ riskAction: 'CHALLENGE_OTP', otpVerified: true })).decision,
      ).toBe(GateDecision.ALLOW);
    });
  });

  describe('precedence', () => {
    /**
     * Ordered by finality. Reporting "waiting for verification" on an order
     * that was already cancelled would send a merchant chasing the customer.
     */
    it('reports cancellation ahead of an OTP hold', () => {
      expect(evaluateGates(order({ status: 'CANCELLED', otpRequired: true })).code).toBe(
        'ORDER_CANCELLED',
      );
    });

    it('reports an existing Shopify order ahead of a risk block', () => {
      expect(
        evaluateGates(order({ shopifyOrderGid: 'gid://x', riskAction: 'BLOCK' })).code,
      ).toBe('ALREADY_PUSHED');
    });
  });
});

describe('shouldEnqueue', () => {
  it('enqueues a clean order', () => {
    expect(shouldEnqueue(order())).toBe(true);
  });

  /**
   * A held order must not occupy a queue slot: it would burn its retry
   * attempts against a condition only a human or a later phase can clear.
   */
  it('does not enqueue a held order', () => {
    expect(shouldEnqueue(order({ otpRequired: true }))).toBe(false);
  });

  it('does not enqueue a blocked order', () => {
    expect(shouldEnqueue(order({ riskAction: 'BLOCK' }))).toBe(false);
  });
});

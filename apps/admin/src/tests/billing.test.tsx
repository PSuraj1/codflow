import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlanDefinition, UsageSummary } from '@codflow/shared';
import { renderWithPolaris } from './render';
import { UsageMeter } from '../components/billing/UsageMeter';
import { PlanCard } from '../components/billing/PlanCard';

/**
 * The billing UI.
 *
 * Both components exist to stop a merchant being surprised, so the tests are
 * about what they *say* rather than how they look: a meter at its cap has to
 * state that orders are being refused, and a plan card must never invite
 * someone to buy what they already have.
 */

function usage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  return {
    metric: 'cod_orders',
    label: 'COD orders',
    used: 10,
    limit: 50,
    percentUsed: 20,
    exceeded: false,
    nearLimit: false,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanDefinition> = {}): PlanDefinition {
  return {
    plan: 'PRO',
    name: 'Pro',
    tagline: 'For stores where COD is the business',
    monthlyUsd: 49,
    trialDays: 7,
    highlights: ['5,000 COD orders a month'],
    ...overrides,
  };
}

describe('UsageMeter', () => {
  it('shows the remaining headroom', () => {
    renderWithPolaris(<UsageMeter usage={usage()} />);

    expect(screen.getByText('10 / 50')).toBeTruthy();
    expect(screen.getByText('40 left this month')).toBeTruthy();
  });

  it('says plainly what happens at the cap', () => {
    renderWithPolaris(<UsageMeter usage={usage({ used: 50, percentUsed: 100, exceeded: true, nearLimit: true })} />);

    // The merchant at 100% is the one who needs the sentence, not the colour.
    expect(screen.getByText(/new ones are being refused/i)).toBeTruthy();
  });

  it('describes an unmetered plan as unlimited rather than showing an empty bar', () => {
    renderWithPolaris(
      <UsageMeter usage={usage({ used: 90_000, limit: null, percentUsed: null })} />,
    );

    expect(screen.getByText('Unlimited on your plan')).toBeTruthy();
    expect(screen.getByText('90,000')).toBeTruthy();
  });

  it('exposes the meter to assistive technology with its own value', () => {
    renderWithPolaris(<UsageMeter usage={usage({ used: 40, percentUsed: 80, nearLimit: true })} />);

    const meter = screen.getByRole('progressbar');
    expect(meter.getAttribute('aria-valuenow')).toBe('80');
  });
});

describe('PlanCard', () => {
  it('marks the merchant’s own plan and offers nothing to buy', async () => {
    const onSelect = vi.fn();
    renderWithPolaris(<PlanCard definition={plan()} currentPlan="PRO" onSelect={onSelect} />);

    expect(screen.getByText('Current plan')).toBeTruthy();

    // Polaris keeps a disabled button focusable and marks it with
    // aria-disabled, so the behaviour is what to assert on.
    await userEvent.click(screen.getByRole('button', { name: 'Your plan' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('says upgrade only when the plan is actually above theirs', () => {
    const { rerender } = renderWithPolaris(
      <PlanCard definition={plan()} currentPlan="FREE" onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Upgrade to Pro' })).toBeTruthy();

    rerender(<PlanCard definition={plan()} currentPlan="ENTERPRISE" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Switch to Pro' })).toBeTruthy();
  });

  it('is honest that Shopify does the charging', () => {
    renderWithPolaris(<PlanCard definition={plan()} currentPlan="FREE" onSelect={vi.fn()} />);

    // The price is in USD but the invoice will be in the merchant's currency;
    // quoting a total the invoice won't match is a support ticket.
    expect(screen.getByText(/billed by Shopify in your currency/i)).toBeTruthy();
  });

  it('hands the chosen plan to its caller', async () => {
    const onSelect = vi.fn();
    renderWithPolaris(<PlanCard definition={plan()} currentPlan="FREE" onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
    expect(onSelect).toHaveBeenCalledWith('PRO');
  });
});

import { describe, expect, it } from 'vitest';
import { SetupStepKey, SetupStepState } from '@codflow/shared';
import { EmbedStatus } from '../../shopify/themeEmbed';
import { buildSteps, summarize, type Facts } from './setupGuide';

/**
 * The setup guide's rules.
 *
 * Two behaviours matter more than the rest, and both are about not lying to a
 * merchant: an optional step must never hold the checklist open, and a check
 * that could not run must never be reported as work the merchant has failed to
 * do.
 */

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    buttons: 4,
    forms: 1,
    codEnabled: true,
    sheetsConnected: false,
    pixels: 0,
    dismissed: false,
    embed: { status: EmbedStatus.ENABLED, themeName: 'Dawn', editorUrl: 'https://example.test' },
    ...overrides,
  };
}

const step = (steps: ReturnType<typeof buildSteps>, key: SetupStepKey) =>
  steps.find((candidate) => candidate.key === key)!;

describe('required progress', () => {
  it('is complete when every required step is done, despite optional ones outstanding', () => {
    // The realistic finished state: live and taking orders, with Sheets and
    // pixels never touched. Counting those would leave every merchant stuck.
    const guide = summarize(buildSteps(facts()), false);

    expect(guide.requiredTotal).toBe(4);
    expect(guide.requiredDone).toBe(4);
    expect(guide.complete).toBe(true);
  });

  it('does not count optional steps towards the total even when they are done', () => {
    const guide = summarize(buildSteps(facts({ sheetsConnected: true, pixels: 2 })), false);

    expect(guide.requiredTotal).toBe(4);
    expect(guide.requiredDone).toBe(4);
  });

  it('is incomplete while the embed is off', () => {
    const guide = summarize(
      buildSteps(facts({ embed: { status: EmbedStatus.ABSENT, themeName: 'Dawn', editorUrl: null } })),
      false,
    );

    expect(guide.requiredDone).toBe(3);
    expect(guide.complete).toBe(false);
  });
});

describe('a check that could not run', () => {
  const unknown = facts({
    embed: { status: EmbedStatus.UNKNOWN, themeName: null, editorUrl: null },
  });

  it('is UNKNOWN rather than TODO', () => {
    expect(step(buildSteps(unknown), SetupStepKey.EMBED).state).toBe(SetupStepState.UNKNOWN);
  });

  it('does not let the guide claim completion', () => {
    const guide = summarize(buildSteps(unknown), false);

    expect(guide.complete).toBe(false);
    expect(guide.requiredDone).toBe(3);
  });

  it('does not tell the merchant they failed to do something', () => {
    const summary = step(buildSteps(unknown), SetupStepKey.EMBED).summary;

    expect(summary).toMatch(/could not check/i);
    expect(summary).not.toMatch(/not enabled/i);
  });
});

describe('the embed step', () => {
  it('names the theme, so the merchant knows which one is being reported on', () => {
    const steps = buildSteps(
      facts({ embed: { status: EmbedStatus.ABSENT, themeName: 'Craft', editorUrl: null } }),
    );

    expect(step(steps, SetupStepKey.EMBED).summary).toContain('Craft');
  });

  it('distinguishes added-but-off from never-added', () => {
    const off = buildSteps(
      facts({ embed: { status: EmbedStatus.DISABLED, themeName: 'Dawn', editorUrl: null } }),
    );
    const absent = buildSteps(
      facts({ embed: { status: EmbedStatus.ABSENT, themeName: 'Dawn', editorUrl: null } }),
    );

    // Different fixes: one is a toggle the merchant already found once, the
    // other means they have never been to the app embeds pane.
    expect(step(off, SetupStepKey.EMBED).summary).toMatch(/switched off/i);
    expect(step(absent, SetupStepKey.EMBED).summary).toMatch(/not enabled/i);
  });

  it('leaves the app rather than routing inside it', () => {
    const embed = step(buildSteps(facts({ embed: { status: EmbedStatus.ABSENT, themeName: 'Dawn', editorUrl: 'https://admin.shopify.com/store/demo/themes/1/editor?context=apps' } })), SetupStepKey.EMBED);

    expect(embed.actionUrl).toContain('context=apps');
    expect(embed.actionPath).toBeNull();
  });

  it('offers no action once it is on', () => {
    expect(step(buildSteps(facts()), SetupStepKey.EMBED).actionLabel).toBeNull();
  });
});

describe('steps seeded at install', () => {
  it('open already done, so the guide starts part-finished rather than empty', () => {
    const steps = buildSteps(facts({ codEnabled: false }));

    expect(step(steps, SetupStepKey.BUTTON).state).toBe(SetupStepState.DONE);
    expect(step(steps, SetupStepKey.FORM).state).toBe(SetupStepState.DONE);
  });

  it('report TODO if seeding ever failed to run', () => {
    const steps = buildSteps(facts({ buttons: 0, forms: 0 }));

    expect(step(steps, SetupStepKey.BUTTON).state).toBe(SetupStepState.TODO);
    expect(step(steps, SetupStepKey.FORM).state).toBe(SetupStepState.TODO);
  });
});

describe('dismissal', () => {
  it('is carried through independently of completion', () => {
    // Hidden while still unfinished is a legitimate state: the merchant is not
    // ready to go live and does not want to be nagged.
    const guide = summarize(buildSteps(facts({ codEnabled: false })), true);

    expect(guide.dismissed).toBe(true);
    expect(guide.complete).toBe(false);
  });
});

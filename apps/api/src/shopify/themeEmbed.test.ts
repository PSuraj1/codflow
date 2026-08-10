import { describe, expect, it } from 'vitest';
import { EmbedStatus, embedStatusFromSettings, parseThemeSettings } from './themeEmbed';

/**
 * App-embed detection.
 *
 * The parser carries the risk here. `settings_data.json` is JSON-with-comments
 * that `JSON.parse` rejects outright, and the tempting fix — strip anything
 * after `//` — corrupts every theme where a merchant has saved a URL. Both
 * failures look like "the theme is broken" to a merchant whose theme is fine.
 */

function settings(blocks: Record<string, { type?: string; disabled?: boolean }>): string {
  return JSON.stringify({ current: { blocks } });
}

const EMBED_TYPE = 'shopify://apps/codflow-codkar/blocks/app-embed/0e9d2f10';

describe('parsing settings_data.json', () => {
  it('reads plain JSON', () => {
    expect(parseThemeSettings('{"current":{"blocks":{}}}')).toEqual({
      current: { blocks: {} },
    });
  });

  it('strips the block-comment banner Shopify ships in its own themes', () => {
    const source = `/*
      * Dawn
      * Do not edit by hand
      */
      {"current": {"blocks": {}}}`;

    expect(parseThemeSettings(source)).toEqual({ current: { blocks: {} } });
  });

  it('strips line comments a developer left behind', () => {
    const source = `{
      // set by the theme editor
      "current": {"blocks": {}}
    }`;

    expect(parseThemeSettings(source)).toEqual({ current: { blocks: {} } });
  });

  it('leaves a URL inside a string alone', () => {
    // The whole reason comment stripping is written out by hand. A naive
    // replace truncates this value at the first slash pair and takes the rest
    // of the file with it.
    const parsed = parseThemeSettings('{"current":{"logo":"https://cdn.example.com/a.png"}}');

    expect(parsed).toEqual({ current: { logo: 'https://cdn.example.com/a.png' } });
  });

  it('leaves an escaped quote followed by a comment marker alone', () => {
    const parsed = parseThemeSettings('{"current":{"label":"say \\"hi\\" // now"}}');

    expect(parsed).toEqual({ current: { label: 'say "hi" // now' } });
  });

  it('throws on genuinely malformed input, so the caller can report UNKNOWN', () => {
    expect(() => parseThemeSettings('{"current":')).toThrow();
  });
});

describe('reading the embed state', () => {
  it('is ENABLED when the block is present and not disabled', () => {
    const parsed = parseThemeSettings(settings({ abc: { type: EMBED_TYPE } }));

    expect(embedStatusFromSettings(parsed)).toBe(EmbedStatus.ENABLED);
  });

  it('is DISABLED when the merchant toggled it off', () => {
    const parsed = parseThemeSettings(settings({ abc: { type: EMBED_TYPE, disabled: true } }));

    expect(embedStatusFromSettings(parsed)).toBe(EmbedStatus.DISABLED);
  });

  it('is ABSENT when the theme has other app embeds but not ours', () => {
    const parsed = parseThemeSettings(
      settings({ xyz: { type: 'shopify://apps/other-app/blocks/reviews/1234' } }),
    );

    expect(embedStatusFromSettings(parsed)).toBe(EmbedStatus.ABSENT);
  });

  it('is ABSENT for a theme with no blocks at all', () => {
    expect(embedStatusFromSettings(parseThemeSettings('{"current":{}}'))).toBe(
      EmbedStatus.ABSENT,
    );
  });

  it('still matches after the app handle changes', () => {
    // The handle is part of the block type and this app's has already changed
    // once. Matching the full path would have silently reported ABSENT for
    // every merchant who enabled the embed before the change.
    const parsed = parseThemeSettings(
      settings({ abc: { type: 'shopify://apps/a-totally-different-handle/blocks/app-embed/99' } }),
    );

    expect(embedStatusFromSettings(parsed)).toBe(EmbedStatus.ENABLED);
  });

  it('does not mistake the COD button block for the app embed', () => {
    const parsed = parseThemeSettings(
      settings({ abc: { type: 'shopify://apps/codflow-codkar/blocks/cod-button/77' } }),
    );

    expect(embedStatusFromSettings(parsed)).toBe(EmbedStatus.ABSENT);
  });
});

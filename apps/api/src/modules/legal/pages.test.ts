import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGAL_PAGES } from '@codflow/shared';
import { PAGES } from './controller';

/**
 * Legal pages, end to end from link to file.
 *
 * The admin footer renders a link for every entry in `LEGAL_PAGES`, and these
 * URLs also go on the App Store listing. Both of the ways that chain can break
 * are silent in development:
 *
 *  - a slug linked but not routed, which 404s for the reviewer who clicks it;
 *  - a slug routed but whose markdown file is absent from the *deployment*,
 *    which is not hypothetical — `**\/*.md` in `.dockerignore` once matched
 *    `docs/legal/*.md`, so every policy URL 404'd in production while working
 *    locally.
 */

const DOCS = path.resolve(__dirname, '../../../../..', 'docs/legal');

describe('every linked page is served', () => {
  it.each(LEGAL_PAGES.map((page) => page.slug))('routes %s', (slug) => {
    expect(PAGES[slug]).toBeDefined();
  });

  it('serves nothing the footer does not link', () => {
    // A page reachable but unlinked is a document nobody can find, and one the
    // listing may still point at after it was meant to be retired.
    expect(Object.keys(PAGES).sort()).toEqual(LEGAL_PAGES.map((page) => page.slug).sort());
  });

  it('keeps the titles the shared list declares', () => {
    for (const page of LEGAL_PAGES) {
      expect(PAGES[page.slug]?.title).toBe(page.title);
    }
  });
});

describe('every served page has its document', () => {
  it.each(LEGAL_PAGES.map((page) => page.slug))('%s has a readable markdown file', async (slug) => {
    const file = PAGES[slug]?.file;

    expect(file).toBeTruthy();
    await expect(access(path.join(DOCS, file as string))).resolves.toBeUndefined();
  });
});

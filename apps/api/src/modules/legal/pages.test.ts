import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP_PAGES, LEGAL_PAGES } from '@codflow/shared';
import { HELP, PAGES } from './controller';

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

const DOCS = path.resolve(__dirname, '../../../../..', 'docs');

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

describe('help pages', () => {
  it.each(HELP_PAGES.map((page) => page.slug))('routes %s', (slug) => {
    expect(HELP[slug]).toBeDefined();
  });

  it.each(HELP_PAGES.map((page) => page.slug))('%s has a readable markdown file', async (slug) => {
    // Lives under docs/help, which needs its own `.dockerignore` negation and
    // its own Dockerfile COPY. Missing either ships an image where the FAQ
    // 404s and nothing else changes.
    const file = HELP[slug]?.file;

    expect(file).toMatch(/^help\//);
    await expect(access(path.join(DOCS, file as string))).resolves.toBeUndefined();
  });

  it('is kept out of the legal set', () => {
    // The FAQ is support material, not a contract. Serving it from /legal
    // implied a review it has not had.
    for (const page of HELP_PAGES) {
      expect(PAGES[page.slug]).toBeUndefined();
    }
  });
});

/**
 * Cross-links between the documents.
 *
 * These broke silently and shipped: the renderer turns `[x](y.md)` into
 * `href="y"`, so `[Privacy Policy](privacy-policy.md)` resolved to
 * `/legal/privacy-policy` while the page is served at `/legal/privacy`. Six
 * such links were live, one of them on the Support page a reviewer reads.
 *
 * Documents must therefore link by **slug**, not filename, and this is what
 * says so out loud.
 */
describe('cross-links resolve', () => {
  /** Every URL the app actually serves a document at. */
  const SERVED_PATHS = new Set([
    ...LEGAL_PAGES.map((page) => `/legal/${page.slug}`),
    ...HELP_PAGES.map((page) => `/help/${page.slug}`),
  ]);

  const DOCUMENTS = [
    ...LEGAL_PAGES.map((page) => ({ slug: page.slug, mount: '/legal', file: PAGES[page.slug]!.file })),
    ...HELP_PAGES.map((page) => ({ slug: page.slug, mount: '/help', file: HELP[page.slug]!.file })),
  ];

  it.each(DOCUMENTS)('$slug links only to pages that exist', async ({ slug, mount, file }) => {
    const source = await readFile(path.join(DOCS, file), 'utf8');

    const targets = Array.from(source.matchAll(/\]\(([^)]+)\)/g))
      .map((match) => match[1] as string)
      .filter((href) => !href.startsWith('https://') && !href.startsWith('#'));

    for (const target of targets) {
      // A `.md` suffix means the author linked by filename; the renderer strips
      // only the extension and produces a URL that does not exist.
      expect(target.endsWith('.md'), `${slug} links by filename: ${target}`).toBe(false);

      // A bare slug is relative to the document's own mount, so it can only
      // reach a sibling. The FAQ lives under /help and the policies under
      // /legal, which is exactly where a bare `support` in the FAQ would have
      // resolved to /help/support and 404'd.
      const resolved = target.startsWith('/') ? target : `${mount}/${target}`;

      expect(SERVED_PATHS.has(resolved), `${slug} links to nothing: ${target} -> ${resolved}`).toBe(
        true,
      );
    }
  });
});

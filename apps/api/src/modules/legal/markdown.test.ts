import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderPage } from './markdown';

/**
 * The legal page renderer.
 *
 * It only ever renders four documents in this repository, so the interesting
 * test is not "does it handle arbitrary Markdown" — it does not, deliberately —
 * but "does it handle *these* documents completely". A construct added to a
 * policy that the renderer does not know would otherwise publish literal `##`
 * or an unformatted `|` table to a URL on the App Store listing.
 *
 * So the last block renders every real document and fails on any surviving
 * syntax, which is a guarantee that survives someone editing the policies
 * without reading this file.
 */

const DOCS = path.resolve(__dirname, '../../../../..', 'docs/legal');

describe('escaping', () => {
  it('escapes HTML in the source', () => {
    expect(renderMarkdown('A <script>alert(1)</script> tag')).toContain('&lt;script&gt;');
  });

  it('escapes ampersands and quotes', () => {
    expect(renderMarkdown('Tom & "Jerry"')).toContain('Tom &amp; &quot;Jerry&quot;');
  });
});

describe('block constructs', () => {
  it('renders headings at their level', () => {
    expect(renderMarkdown('## Who this covers')).toBe('<h2>Who this covers</h2>');
  });

  it('joins a wrapped paragraph into one', () => {
    expect(renderMarkdown('One line\nand its continuation.')).toBe(
      '<p>One line and its continuation.</p>',
    );
  });

  it('renders a bullet list', () => {
    expect(renderMarkdown('- First\n- Second')).toBe('<ul><li>First</li><li>Second</li></ul>');
  });

  it('keeps a wrapped list item in one bullet', () => {
    expect(renderMarkdown('- A claim that\n  wraps onto a second line')).toBe(
      '<ul><li>A claim that wraps onto a second line</li></ul>',
    );
  });

  it('renders a task list with its state', () => {
    const html = renderMarkdown('- [ ] Not done\n- [x] Done');
    expect(html).toContain('☐ Not done');
    expect(html).toContain('☑ Done');
  });

  it('renders a numbered list', () => {
    expect(renderMarkdown('1. First\n2. Second')).toBe('<ol><li>First</li><li>Second</li></ol>');
  });

  it('renders a table', () => {
    const html = renderMarkdown('| Who | What |\n|---|---|\n| Shopify | The order |');

    expect(html).toContain('<th>Who</th>');
    expect(html).toContain('<td>Shopify</td>');
    expect(html).not.toContain('|');
  });

  it('folds a multi-line blockquote into one', () => {
    const html = renderMarkdown('> This is a draft\n> and not legal advice.');
    expect(html).toBe('<blockquote><p>This is a draft and not legal advice.</p></blockquote>');
  });
});

describe('inline formatting', () => {
  it('renders bold', () => {
    expect(renderMarkdown('**Mandatory**')).toContain('<strong>Mandatory</strong>');
  });

  it('renders inline code', () => {
    expect(renderMarkdown('the `drive.file` scope')).toContain('<code>drive.file</code>');
  });

  /** The documents link to each other by filename; the URLs have no extension. */
  it('rewrites a link between documents onto its served path', () => {
    expect(renderMarkdown('See the [Privacy Policy](privacy-policy.md).')).toContain(
      '<a href="privacy-policy">Privacy Policy</a>',
    );
  });

  /**
   * Nothing merchant-authored reaches this renderer, but a policy is a public
   * page and a `javascript:` href in one would be an own goal.
   */
  it('drops a link target that is not relative or https', () => {
    const html = renderMarkdown('[Click](javascript:alert(1))');

    expect(html).not.toContain('javascript:');
    expect(html).toContain('Click');
  });
});

describe('the page shell', () => {
  it('escapes the title', () => {
    expect(renderPage('<b>x</b>', '')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('needs no JavaScript or external assets', () => {
    const html = renderPage('Privacy Policy', '<h1>Privacy</h1>');

    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).toContain('<!doctype html>');
  });
});

describe('the real documents', () => {
  const files = readdirSync(DOCS).filter((name) => name.endsWith('.md'));

  it('finds the documents the listing points at', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'privacy-policy.md',
        'terms-of-service.md',
        'data-processing-addendum.md',
        'support.md',
      ]),
    );
  });

  it.each(files)('renders %s with no Markdown left over', (name) => {
    const html = renderMarkdown(readFileSync(path.join(DOCS, name), 'utf8'));

    // Each of these would be visible as raw syntax on a public policy page.
    expect(html, 'unrendered heading').not.toMatch(/^#{1,4}\s/m);
    expect(html, 'unrendered table row').not.toMatch(/^\|/m);
    expect(html, 'unrendered bullet').not.toMatch(/^[-*]\s/m);
    expect(html, 'unrendered blockquote').not.toMatch(/^>\s/m);
    expect(html, 'unrendered bold').not.toContain('**');
    expect(html, 'unrendered link').not.toMatch(/\]\(/);
  });

  /**
   * The placeholders are the point of the drafts, not a defect — but they must
   * not be published by accident, so this records that they are still there.
   * Delete this test once the documents are filled in and reviewed.
   *
   * Scoped to the four legal documents rather than every file in the folder.
   * `faq.md` is a support document, not a draft contract: it has no blanks to
   * fill and needs no lawyer, so asserting it still contains placeholders would
   * fail forever and say nothing.
   */
  const AWAITING_REVIEW = [
    'privacy-policy.md',
    'terms-of-service.md',
    'data-processing-addendum.md',
    'support.md',
  ];

  it.each(AWAITING_REVIEW)('%s still has placeholders awaiting real values', (name) => {
    expect(readFileSync(path.join(DOCS, name), 'utf8')).toMatch(/\[[A-Z][A-Z\s/,.-]+\]/);
  });
});

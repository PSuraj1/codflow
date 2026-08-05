import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';
import { renderMarkdown, renderPage } from './markdown';

const log = createLogger('legal');

/**
 * The public legal pages.
 *
 * Their URLs go on the Shopify App Store listing, which means three things
 * follow: they must be reachable without authentication, they must never move,
 * and they must render in the production image. The Dockerfile copies
 * `docs/legal` for that last reason — serving them from a directory the build
 * discards would work in development and 404 for Shopify's reviewer.
 *
 * Markdown is the source of truth rather than HTML held here, because these are
 * documents a lawyer edits and a founder pastes into the Partner Dashboard.
 */

/**
 * Path to `docs/legal`, from either `src/` or the compiled `dist/`.
 *
 * `__dirname` rather than `import.meta.dirname` because this workspace compiles
 * to CommonJS. Both layouts sit five levels below the repository root —
 * `apps/api/{src,dist}/modules/legal` — so one path serves development and the
 * container alike.
 */
const DOCS = path.resolve(__dirname, '../../../../..', 'docs/legal');

interface LegalPage {
  readonly file: string;
  readonly title: string;
}

export const PAGES: Readonly<Record<string, LegalPage>> = {
  privacy: { file: 'privacy-policy.md', title: 'Privacy Policy' },
  terms: { file: 'terms-of-service.md', title: 'Terms of Service' },
  dpa: { file: 'data-processing-addendum.md', title: 'Data Processing Addendum' },
  support: { file: 'support.md', title: 'Support' },
};

/**
 * Rendered pages, cached after the first read.
 *
 * They change only on deploy, so re-reading and re-rendering per request would
 * be disk work for nothing. Cached on success only — a transient read failure
 * must not be remembered as a permanent one.
 */
const cache = new Map<string, string>();

async function render(slug: string): Promise<string> {
  const cached = cache.get(slug);
  if (cached) return cached;

  const page = PAGES[slug];
  if (!page) throw new NotFoundError('No such page');

  let source: string;

  try {
    source = await readFile(path.join(DOCS, page.file), 'utf8');
  } catch (error) {
    // Worth an error-level log: a missing legal page is a broken URL on a
    // public app listing, and nothing else in the app will notice.
    log.error({ err: error, slug, docs: DOCS }, 'Legal page is missing from the deployment');
    throw new NotFoundError('This page is temporarily unavailable');
  }

  const html = renderPage(page.title, renderMarkdown(source));
  cache.set(slug, html);

  return html;
}

/** `GET /legal/:page` — a public, unauthenticated policy page. */
export async function serve(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const html = await render(req.params.page as string);

    res.type('html');
    // Long enough to be cheap, short enough that a correction to a published
    // policy reaches readers the same day.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (error) {
    next(error);
  }
}

/** `GET /legal` — an index, so the base URL is not a dead end. */
export function index(_req: Request, res: Response): void {
  const links = Object.entries(PAGES)
    .map(([slug, page]) => `<li><a href="/legal/${slug}">${page.title}</a></li>`)
    .join('');

  res.type('html');
  res.send(renderPage('Legal', `<h1>CodFlow</h1><ul>${links}</ul>`));
}

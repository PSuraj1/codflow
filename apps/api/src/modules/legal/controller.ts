import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { HELP_PAGES, LEGAL_PAGES, type HelpSlug, type LegalSlug } from '@codflow/shared';
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
const DOCS = path.resolve(__dirname, '../../../../..', 'docs');

interface LegalPage {
  readonly file: string;
  readonly title: string;
}

/**
 * Which markdown file backs each slug.
 *
 * Typed as `Record<LegalSlug, string>` deliberately: adding a page to
 * `LEGAL_PAGES` in `@codflow/shared` without adding its file here fails the
 * build. The admin footer links every slug in that list, so the alternative is
 * shipping a link to a page this router cannot serve.
 */
const FILES: Readonly<Record<LegalSlug, string>> = {
  support: 'legal/support.md',
  privacy: 'legal/privacy-policy.md',
  terms: 'legal/terms-of-service.md',
  dpa: 'legal/data-processing-addendum.md',
};

/**
 * Help documents. Same machinery, different directory and different standard —
 * `docs/help` is support material, `docs/legal` is contracts awaiting review.
 */
const HELP_FILES: Readonly<Record<HelpSlug, string>> = {
  faq: 'help/faq.md',
};

/** Slug -> document, built from the shared lists so the two cannot diverge. */
export const PAGES: Readonly<Record<string, LegalPage>> = Object.fromEntries(
  LEGAL_PAGES.map((page) => [page.slug, { file: FILES[page.slug], title: page.title }]),
);

export const HELP: Readonly<Record<string, LegalPage>> = Object.fromEntries(
  HELP_PAGES.map((page) => [page.slug, { file: HELP_FILES[page.slug], title: page.title }]),
);

/**
 * Rendered pages, cached after the first read.
 *
 * They change only on deploy, so re-reading and re-rendering per request would
 * be disk work for nothing. Cached on success only — a transient read failure
 * must not be remembered as a permanent one.
 */
const cache = new Map<string, string>();

/** Keyed by file rather than slug, so the two sets cannot collide in the cache. */
async function render(pages: Readonly<Record<string, LegalPage>>, slug: string): Promise<string> {
  const page = pages[slug];
  if (!page) throw new NotFoundError('No such page');

  const cached = cache.get(page.file);
  if (cached) return cached;

  let source: string;

  try {
    source = await readFile(path.join(DOCS, page.file), 'utf8');
  } catch (error) {
    // Worth an error-level log: a missing page is a broken URL on a public app
    // listing, and nothing else in the app will notice.
    log.error({ err: error, slug, docs: DOCS }, 'Served page is missing from the deployment');
    throw new NotFoundError('This page is temporarily unavailable');
  }

  const html = renderPage(page.title, renderMarkdown(source));
  cache.set(page.file, html);

  return html;
}

/**
 * Sends a rendered document.
 *
 * The cache header is the reason both routes share this: an hour is long enough
 * to be cheap and short enough that a correction to a published policy — or an
 * FAQ answer that turned out to be wrong — reaches readers the same day.
 */
async function send(
  pages: Readonly<Record<string, LegalPage>>,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const html = await render(pages, req.params.page as string);

    res.type('html');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (error) {
    next(error);
  }
}

/** `GET /legal/:page` — a public, unauthenticated policy page. */
export function serve(req: Request, res: Response, next: NextFunction): Promise<void> {
  return send(PAGES, req, res, next);
}

/** `GET /help/:page` — the FAQ, and anything else support-facing. */
export function serveHelp(req: Request, res: Response, next: NextFunction): Promise<void> {
  return send(HELP, req, res, next);
}

/** `GET /legal` — an index, so the base URL is not a dead end. */
export function index(_req: Request, res: Response): void {
  const links = Object.entries(PAGES)
    .map(([slug, page]) => `<li><a href="/legal/${slug}">${page.title}</a></li>`)
    .join('');

  res.type('html');
  res.send(renderPage('Legal', `<h1>CODkar</h1><ul>${links}</ul>`));
}

/**
 * The app's legal pages.
 *
 * Lives here because two things need the same list and must never disagree
 * about it: the API serves these documents at `/legal/<slug>`, and the admin
 * links to every one of them from its footer. A footer entry pointing at a slug
 * the server does not serve is a 404 on a policy page — which is exactly the
 * link a Shopify reviewer clicks, and exactly the kind of breakage nothing else
 * in the app would notice.
 *
 * Titles are here; filenames are not. Which markdown file backs a slug is a
 * server concern the admin has no business knowing, and `modules/legal` maps it
 * with a type that fails the build if a page is added here without one.
 */

export interface LegalPageLink {
  /** URL segment: `/legal/<slug>`. */
  readonly slug: string;
  /** Link text, and the `<title>` of the rendered page. */
  readonly title: string;
}

/**
 * The contracts, and only the contracts. Support material lives in
 * `HELP_PAGES` — see the note there for why the two are kept apart.
 */
export const LEGAL_PAGES = [
  { slug: 'support', title: 'Support' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'dpa', title: 'Data Processing Addendum' },
] as const satisfies readonly LegalPageLink[];

export type LegalSlug = (typeof LEGAL_PAGES)[number]['slug'];

/** The public path for a legal page. One definition, so the shape cannot drift. */
export function legalPath(slug: LegalSlug): string {
  return `/legal/${slug}`;
}

/**
 * Help pages, served from `/help/<slug>`.
 *
 * Separate from `LEGAL_PAGES` because the two are different kinds of document
 * and conflating them has a cost in both directions: the policies are drafts a
 * lawyer must review and are held to that standard, while the FAQ is support
 * material anyone on the team should be able to correct the moment a merchant
 * asks something new. Filing the FAQ under `/legal/` implied a review it does
 * not need, and made the placeholder tripwire on the legal drafts fail against
 * a document that has no blanks to fill.
 */
export const HELP_PAGES = [{ slug: 'faq', title: 'FAQ' }] as const satisfies readonly LegalPageLink[];

export type HelpSlug = (typeof HELP_PAGES)[number]['slug'];

export function helpPath(slug: HelpSlug): string {
  return `/help/${slug}`;
}

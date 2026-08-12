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
 * Order matters — it is the footer's order. FAQ and Support lead because a
 * merchant reaching the footer usually wants help, not the terms.
 */
export const LEGAL_PAGES = [
  { slug: 'faq', title: 'FAQ' },
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

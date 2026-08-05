import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * Custom elements App Bridge defines on the page.
 *
 * App Bridge is loaded from Shopify's CDN rather than bundled, so it ships no
 * types of its own. Declaring the elements it registers here is what lets them
 * be written as ordinary JSX — the alternative is a `@ts-expect-error` above
 * every usage, which silently stops protecting anything the moment Shopify does
 * ship types and the directive becomes "unused".
 */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * Renders navigation into the Shopify admin's own sidebar, outside the
       * app iframe. The first child anchor must be `href="/" rel="home"`; it
       * supplies the app's title and is not shown as a link.
       */
      'ui-nav-menu': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
      /** Renders a title bar with actions above the app frame. */
      'ui-title-bar': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & { title?: string },
        HTMLElement
      >;
      /** A modal owned by the admin rather than the app iframe. */
      'ui-modal': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & { id?: string; variant?: string },
        HTMLElement
      >;
      'ui-save-bar': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & { id?: string },
        HTMLElement
      >;
    }
  }
}

/**
 * Attributes App Bridge reads from ordinary `<button>` elements nested inside
 * its custom elements, to decide how to paint the copy it renders outside the
 * frame.
 *
 * Declared as an augmentation rather than cast at each call site because the
 * alternative is a cast through `unknown` in every save bar and title bar —
 * and a cast silently stops checking everything else about the element too.
 * The looseness is contained: this affects the intrinsic `<button>` only, and
 * Polaris's `Button` is a component with its own props.
 */
declare module 'react' {
  interface ButtonHTMLAttributes<T> {
    /** `primary` marks the confirming action. Read by `ui-save-bar`. */
    variant?: string;
    /** Present, at any value, renders the App Bridge button as busy. */
    loading?: string;
    tone?: string;
  }
}

export {};

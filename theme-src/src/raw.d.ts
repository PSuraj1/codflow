/**
 * Vite's `?raw` import suffix, which yields a module's text rather than its
 * exports.
 *
 * Declared here because `theme-src/tsconfig.json` sets `"types": []` on
 * purpose — the bundle sources run in a shopper's browser, and admitting
 * `@types/node` would let one of them reach for `fs` and fail only at runtime.
 * A test that needs to read a shipped asset therefore reads it through the
 * bundler rather than through Node.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}

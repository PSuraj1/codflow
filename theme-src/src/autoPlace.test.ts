import { afterEach, describe, expect, it } from 'vitest';
// The shipped asset's text, inlined by the bundler. See `raw.d.ts` for why this
// is not `fs.readFileSync`.
import SOURCE from '../../extensions/codflow-theme/assets/codflow.js?raw';

/**
 * Where the COD button lands on a product page.
 *
 * `codflow.js` is a hand-written IIFE with no build step and no exports, so it
 * cannot be imported and unit-tested the way the bundled sources can. What
 * *can* be tested is the part that actually breaks: the selector lists. They
 * are the app's only contract with a theme's markup, and a theme matching none
 * of them renders no button at all while every other part of the app reports
 * itself healthy.
 *
 * So the lists are read out of the shipped asset and run against markup from
 * the theme families that matter. Reading the real file rather than a copy is
 * the point — a copy would keep passing after someone edits the asset.
 */

/**
 * Pulls a `var NAME = [ ... ]` string array out of the asset.
 *
 * Anchored on the array's closing `];` on its own line rather than the first
 * `]` — selectors like `[data-add-to-cart]` and `form[action*="/cart/add"]`
 * contain brackets, so a lazy match to the first one silently truncates the
 * list and every fixture below then fails for the wrong reason.
 */
function selectorList(name: string): string[] {
  const match = new RegExp(`var ${name} = \\[([\\s\\S]*?)\\n\\s*\\];`).exec(SOURCE);

  if (!match) throw new Error(`${name} not found in codflow.js — was it renamed?`);

  return Array.from(match[1]!.matchAll(/'([^']+)'/g)).map((entry) => entry[1]!);
}

const PRODUCT_ANCHORS = selectorList('PRODUCT_ANCHORS');
const ADD_TO_CART_CONTROLS = selectorList('ADD_TO_CART_CONTROLS');

/** Mirrors the runtime's order: containers first, then the buy-button fallback. */
function findsAnchor(html: string): boolean {
  document.body.innerHTML = html;

  if (PRODUCT_ANCHORS.some((selector) => document.querySelector(selector))) return true;

  return ADD_TO_CART_CONTROLS.some((selector) => document.querySelector(selector));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the selector lists are well formed', () => {
  it('found both lists in the shipped asset', () => {
    expect(PRODUCT_ANCHORS.length).toBeGreaterThan(0);
    expect(ADD_TO_CART_CONTROLS.length).toBeGreaterThan(0);
  });

  it('contains only selectors the browser will accept', () => {
    // An invalid selector is caught and skipped at runtime, so a typo silently
    // removes one fallback rather than failing loudly.
    for (const selector of [...PRODUCT_ANCHORS, ...ADD_TO_CART_CONTROLS]) {
      expect(() => document.querySelector(selector)).not.toThrow();
    }
  });
});

describe('themes the button must reach', () => {
  it('Dawn and every Online Store 2.0 theme Shopify ships', () => {
    expect(
      findsAnchor(`
        <product-form class="product-form">
          <form action="/cart/add" method="post">
            <div class="product-form__buttons">
              <button type="submit" name="add" class="product-form__submit">Add to cart</button>
            </div>
          </form>
        </product-form>
      `),
    ).toBe(true);
  });

  it('Debut and Brooklyn, still live on a large share of stores', () => {
    expect(
      findsAnchor(`
        <form action="/cart/add" method="post" id="AddToCartForm" class="product-single__form">
          <button type="submit" name="add" id="AddToCart">Add to cart</button>
        </form>
      `),
    ).toBe(true);
  });

  it('Prestige, whose buy buttons use its own class names', () => {
    expect(
      findsAnchor(`
        <form action="/cart/add" method="post">
          <div class="ProductForm__BuyButtons">
            <button type="submit" name="add">Add to cart</button>
          </div>
        </form>
      `),
    ).toBe(true);
  });

  it('a theme with only a payment button and no cart form', () => {
    expect(findsAnchor('<div class="shopify-payment-button"><button>Buy it now</button></div>')).toBe(
      true,
    );
  });

  it('a custom theme matching none of the container selectors', () => {
    // The case the buy-button fallback exists for: bespoke markup that still
    // has to submit to Shopify's cart endpoint, so `name="add"` survives.
    expect(
      findsAnchor(`
        <section class="pdp">
          <div class="pdp__purchase">
            <button type="submit" name="add">Add to bag</button>
          </div>
        </section>
      `),
    ).toBe(true);
  });
});

describe('pages with nothing to anchor to', () => {
  it('finds nothing on a page with no product form at all', () => {
    // Must stay false: a match here would place a COD button on a page with no
    // variant to order, and the form needs one.
    expect(findsAnchor('<main><h1>About us</h1><p>Our story.</p></main>')).toBe(false);
  });

  it('does not treat a search or newsletter form as a product form', () => {
    expect(
      findsAnchor(`
        <form action="/search"><input name="q"><button type="submit">Search</button></form>
        <form action="/contact#newsletter"><button type="submit">Subscribe</button></form>
      `),
    ).toBe(false);
  });
});

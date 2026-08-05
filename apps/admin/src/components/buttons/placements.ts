import type { CustomizableButtonPlacement } from '@codflow/shared';

/**
 * How each placement is described to a merchant.
 *
 * The descriptions carry the one thing the screen cannot show: four of these
 * placements only appear where the merchant has dragged the CodFlow block into
 * their theme, and the product-page button is the sole exception because the
 * app auto-places it. A merchant who enables the home-page button and sees
 * nothing has not hit a bug — they have not added the block — and that sentence
 * belongs next to the switch, not in a help centre article.
 */

interface PlacementCopy {
  readonly title: string;
  readonly description: string;
}

export const PLACEMENT_COPY: Record<CustomizableButtonPlacement, PlacementCopy> = {
  PRODUCT_PAGE: {
    title: 'Product page',
    description:
      'Placed automatically next to Add to cart. Drag the CodFlow block into your product template to put it somewhere else.',
  },
  CART_PAGE: {
    title: 'Cart page',
    description:
      'Appears where you add the CodFlow block to your cart template. It orders everything in the cart.',
  },
  COLLECTION_PAGE: {
    title: 'Collection page',
    description: 'Appears where you add the CodFlow block to a collection template.',
  },
  HOME_PAGE: {
    title: 'Home page',
    description: 'Appears where you add the CodFlow block to a section on your home page.',
  },
  STICKY_MOBILE: {
    title: 'Sticky bar',
    description:
      'Pinned to the bottom of the screen. Added by the app itself, so no theme change is needed.',
  },
  FLOATING: {
    title: 'Floating button',
    description:
      'A pill in the corner of the screen, on every page. Added by the app itself, so no theme change is needed.',
  },
};

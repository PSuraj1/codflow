import { Box, InlineStack, Text } from '@shopify/polaris';
import { LEGAL_PAGES, legalPath } from '@codflow/shared';
import { openExternal } from '../lib/appBridge';

/**
 * Policy links, on every screen.
 *
 * Rendered from `LEGAL_PAGES` in `@codflow/shared` rather than a local list, so
 * a page added to the app appears here and a page removed stops being linked —
 * the server builds its routing table from the same array, and a footer link to
 * a slug it does not serve is a 404 on a policy page.
 *
 * Two things about how the links open:
 *
 *  - **A new tab, not the top frame.** These pages live on this app's origin,
 *    so navigating the top frame would replace the entire Shopify admin with a
 *    privacy policy and strand the merchant. `openExternal` is the same helper
 *    the support widget uses.
 *  - **Through App Bridge, not a bare anchor.** The admin embeds this app in a
 *    sandboxed iframe where an untrusted `window.open` is dropped silently, so
 *    a plain `target="_blank"` link can do nothing at all when clicked. App
 *    Bridge's `open` is the path that actually works embedded.
 *
 * They are buttons rather than anchors for that reason. The trade is real — no
 * middle-click, no "copy link address" — so each carries an explicit
 * `aria-label` naming the destination and saying it opens in a new tab, which
 * an anchor would have conveyed on its own.
 */

export function LegalFooter() {
  return (
    <Box
      paddingBlockStart="800"
      paddingBlockEnd="400"
      paddingInlineStart="400"
      paddingInlineEnd="400"
    >
      <InlineStack align="center" gap="300" wrap>
        {LEGAL_PAGES.map((page) => (
          <button
            key={page.slug}
            type="button"
            onClick={() =>
              openExternal(new URL(legalPath(page.slug), window.location.origin).toString())
            }
            aria-label={`${page.title} — opens in a new tab`}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            <Text as="span" variant="bodySm" tone="subdued">
              {page.title}
            </Text>
          </button>
        ))}
      </InlineStack>
    </Box>
  );
}

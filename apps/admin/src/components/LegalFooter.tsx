import { Box, InlineStack, Text } from '@shopify/polaris';
import { HELP_PAGES, LEGAL_PAGES, helpPath, legalPath } from '@codflow/shared';
import { openExternal } from '../lib/appBridge';

/**
 * Help and policy links, on every screen.
 *
 * Rendered from `HELP_PAGES` and `LEGAL_PAGES` in `@codflow/shared` rather than
 * a local list, so a page added to the app appears here and a page removed
 * stops being linked — the server builds its routing from the same arrays, and
 * a footer link to a slug it does not serve is a 404 on a public page.
 *
 * The two groups are separated because they are different offers. The first row
 * is where a stuck merchant goes; the second is the paperwork. Running them
 * together as one list of six buries the FAQ between a privacy policy and a
 * data processing addendum.
 *
 * Two things about how the links open:
 *
 *  - **A new tab, not the top frame.** These pages live on this app's origin,
 *    so navigating the top frame would replace the entire Shopify admin with a
 *    policy page and strand the merchant.
 *  - **Through App Bridge, not a bare anchor.** The admin embeds this app in a
 *    sandboxed iframe where an untrusted `window.open` is dropped silently, so
 *    a plain `target="_blank"` link can do nothing at all when clicked.
 *
 * They are buttons rather than anchors for that reason. The trade is real — no
 * middle-click, no "copy link address" — so each carries an explicit
 * `aria-label` naming the destination and saying it opens in a new tab.
 */

/**
 * Injected by Vite at build time, exactly as `SupportWidget` reads it. Empty
 * when the deployment configured no channel, and the link is then omitted — a
 * support link opening a blank Telegram page is worse than no link.
 */
declare const __SUPPORT_TELEGRAM_URL__: string;

const TELEGRAM_URL =
  typeof __SUPPORT_TELEGRAM_URL__ === 'string' ? __SUPPORT_TELEGRAM_URL__.trim() : '';

const LINK_STYLE = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  font: 'inherit',
} as const;

function FooterLink({ label, url, hint }: { label: string; url: string; hint?: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      aria-label={`${hint ?? label} — opens in a new tab`}
      style={LINK_STYLE}
    >
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
    </button>
  );
}

/** Absolute, because a relative path would resolve against admin.shopify.com. */
function appUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function LegalFooter() {
  return (
    <Box
      paddingBlockStart="800"
      paddingBlockEnd="400"
      paddingInlineStart="400"
      paddingInlineEnd="400"
    >
      <Box paddingBlockEnd="200">
        <InlineStack align="center" gap="300" wrap>
          {HELP_PAGES.map((page) => (
            <FooterLink key={page.slug} label={page.title} url={appUrl(helpPath(page.slug))} />
          ))}

          {TELEGRAM_URL ? (
            <FooterLink label="Chat on Telegram" url={TELEGRAM_URL} hint="Chat with support on Telegram" />
          ) : null}
        </InlineStack>
      </Box>

      <InlineStack align="center" gap="300" wrap>
        {LEGAL_PAGES.map((page) => (
          <FooterLink key={page.slug} label={page.title} url={appUrl(legalPath(page.slug))} />
        ))}
      </InlineStack>
    </Box>
  );
}

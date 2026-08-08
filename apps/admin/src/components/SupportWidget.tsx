import { openExternal } from '../lib/appBridge';

/**
 * The floating support button.
 *
 * Merchants running COD are usually not developers, and the moment they need
 * help is the moment something on their storefront has stopped taking orders.
 * A contact route that is always on screen — rather than buried on a settings
 * page they would have to think to look for — is the difference between a
 * question and an uninstall.
 *
 * Deliberately *not* plan-gated. `prioritySupport` governs how fast an answer
 * comes, not whether a merchant may ask; hiding the way to reach a human from
 * the merchants on the free tier is how a free tier becomes a bad review.
 *
 * The URL is build configuration (`SUPPORT_TELEGRAM_URL`), identical for every
 * merchant, and the widget renders nothing when it is unset — a support button
 * that opens an empty Telegram page is worse than no button at all.
 */

/** Injected by Vite at build time. Empty when the deployment set no channel. */
declare const __SUPPORT_TELEGRAM_URL__: string;

const TELEGRAM_URL =
  typeof __SUPPORT_TELEGRAM_URL__ === 'string' ? __SUPPORT_TELEGRAM_URL__.trim() : '';

/**
 * Telegram's mark, inline.
 *
 * Inline rather than an asset request: it is 300 bytes, and a floating button
 * whose icon arrives a beat after the button does looks broken.
 */
function TelegramIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M21.94 4.6l-3.02 14.25c-.23 1.01-.83 1.26-1.68.78l-4.64-3.42-2.24 2.15c-.25.25-.46.46-.94.46l.33-4.73 8.6-7.77c.37-.33-.08-.52-.58-.19L7.14 12.83l-4.58-1.43c-1-.31-1.01-1 .21-1.48l17.9-6.9c.83-.3 1.56.2 1.27 1.58z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SupportWidget() {
  if (!TELEGRAM_URL) return null;

  return (
    <div
      style={{
        position: 'fixed',
        // Clears Shopify's own bottom chrome and the contextual save bar, which
        // slides up from the same corner.
        right: 20,
        bottom: 24,
        zIndex: 400,
      }}
    >
      <button
        type="button"
        onClick={() => openExternal(TELEGRAM_URL)}
        aria-label="Contact CODkar support on Telegram"
        title="Support on Telegram"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 48,
          height: 48,
          borderRadius: '50%',
          border: 'none',
          // Telegram's own blue. A neutral button here reads as part of the
          // app's chrome rather than as a link to somewhere else.
          background: '#229ED9',
          color: '#ffffff',
          cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.25)',
        }}
      >
        <TelegramIcon />
      </button>
    </div>
  );
}

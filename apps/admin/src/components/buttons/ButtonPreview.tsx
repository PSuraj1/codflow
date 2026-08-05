import { BlockStack, Box, Card, InlineStack, Text } from '@shopify/polaris';
import type { ButtonConfigSummary } from '@codflow/shared';

/**
 * What the shopper will see.
 *
 * Built from the same custom properties the theme extension writes — `--codflow-bg`,
 * `--codflow-pad-y` and the rest, in `buttonStyle()` — so the preview and the
 * storefront cannot disagree about what a value means. An approximation would
 * be worse than nothing here: colours and spacing are the whole subject of this
 * screen, and a merchant who trusts a preview that lies ships a button they
 * never actually looked at.
 *
 * Two things it deliberately does not reproduce. Custom CSS is not applied,
 * because the merchant's rules are written against the storefront's cascade and
 * would leak into the Polaris admin around it. And the surrounding page is the
 * theme's, so this shows the button on a neutral surface rather than pretending
 * to be a product page.
 */

interface Props {
  button: ButtonConfigSummary;
  /** False when the plan does not include custom CSS, to explain the omission. */
  customCssActive?: boolean;
}

export function ButtonPreview({ button, customCssActive = true }: Props) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Preview
        </Text>

        <Box background="bg-surface-secondary" padding="500" borderRadius="200">
          <InlineStack align={button.fullWidth ? 'start' : 'center'} blockAlign="center">
            <button
              type="button"
              // Inert: this is a picture of a button, and a click here has
              // nothing to open. `disabled` would grey it out and misrepresent
              // the colours, which are the point.
              aria-disabled="true"
              onClick={(event) => event.preventDefault()}
              data-testid="cod-button-preview"
              className={
                button.animation === 'none' ? undefined : `codflow-preview-anim-${button.animation}`
              }
              style={{
                background: button.bgColor,
                color: button.textColor,
                border: `1px solid ${button.borderColor}`,
                borderRadius: `${button.borderRadius}px`,
                fontSize: `${button.fontSize}px`,
                fontWeight: Number(button.fontWeight),
                padding: `${button.paddingY}px ${button.paddingX}px`,
                width: button.fullWidth ? '100%' : 'auto',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '2px',
                cursor: 'default',
                lineHeight: 1.3,
              }}
            >
              <span>{button.label}</span>
              {button.subLabel ? (
                <span style={{ fontSize: `${Math.max(11, button.fontSize - 4)}px`, opacity: 0.85 }}>
                  {button.subLabel}
                </span>
              ) : null}
            </button>
          </InlineStack>
        </Box>

        {button.customCss && customCssActive ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Your custom CSS is not applied here — it is written for your storefront, not for this
            page. Check it on your store.
          </Text>
        ) : null}

        {!button.isEnabled ? (
          <Text as="p" variant="bodySm" tone="subdued">
            This placement is switched off, so nothing renders on your storefront yet.
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

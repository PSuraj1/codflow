import { BlockStack, Card, Text } from '@shopify/polaris';
import type { LogoAlignment, ShopBrandingSummary } from '@codflow/shared';

/**
 * The COD form, approximately.
 *
 * Built from the same values `applyBranding` writes into custom properties on
 * the storefront, so the colours and radius are exact. The *layout* is not a
 * reproduction — the real form carries an order summary, the merchant's own
 * field list and a locale-dependent direction, none of which belong on a
 * colour-picking screen. What this has to get right is what a colour change
 * looks like, and that it does.
 *
 * Custom CSS is deliberately not applied: those rules are written against the
 * storefront's cascade and would leak into the Polaris admin around this card.
 */

/**
 * The storefront centres and right-aligns the logo with `auto` margins on a
 * block image; this preview lays its header out with flex, so the same three
 * choices are expressed as `align-self`.
 */
const ALIGNMENT_TO_FLEX: Record<LogoAlignment, string> = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
};

interface Props {
  branding: ShopBrandingSummary;
}

export function FormAppearancePreview({ branding }: Props) {
  const dark = branding.themeMode === 'DARK';

  const surface = dark ? '#1a1a1a' : '#ffffff';
  const field = dark ? '#2a2a2a' : '#ffffff';
  const border = dark ? '#444444' : '#d9d9d9';

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Preview
        </Text>

        <div
          data-testid="form-appearance-preview"
          style={{
            background: surface,
            color: branding.textColor,
            fontFamily: branding.fontFamily,
            borderRadius: `${branding.borderRadius}px`,
            border: `1px solid ${border}`,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {branding.logoUrl ? (
            <img
              src={branding.logoUrl}
              alt=""
              style={{
                // Mirrors what the storefront does, so the preview cannot
                // promise a size or position the form will not honour.
                height: branding.logoHeight,
                maxWidth: '100%',
                objectFit: 'contain',
                alignSelf: ALIGNMENT_TO_FLEX[branding.logoAlignment],
              }}
            />
          ) : null}

          <div style={{ fontWeight: 600, fontSize: 15 }}>Cash On Delivery</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>Pay when your order arrives.</div>

          {['Full name', 'Phone number'].map((label) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 11, opacity: 0.8 }}>{label}</span>
              <span
                style={{
                  background: field,
                  border: `1px solid ${border}`,
                  borderRadius: `${Math.min(branding.borderRadius, 12)}px`,
                  height: 26,
                }}
              />
            </div>
          ))}

          <span
            style={{
              background: branding.primaryColor,
              // The storefront uses the secondary for hover; showing it as a
              // bottom edge is the only way a still image can convey that the
              // two are related rather than arbitrary.
              borderBottom: `3px solid ${branding.secondaryColor}`,
              color: '#ffffff',
              borderRadius: `${branding.borderRadius}px`,
              padding: '9px 12px',
              textAlign: 'center',
              fontWeight: 600,
              fontSize: 13,
              marginTop: 4,
            }}
          >
            Place Order
          </span>
        </div>

        <Text as="p" variant="bodySm" tone="subdued">
          Your own fields and order summary appear on the real form — this shows the colours and
          shape only.
        </Text>
      </BlockStack>
    </Card>
  );
}

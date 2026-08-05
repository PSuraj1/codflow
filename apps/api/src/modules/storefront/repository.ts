import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';

/**
 * Storefront reads.
 *
 * Every query here runs on the anonymous request path, so each one selects
 * explicit columns rather than whole rows. That is not a micro-optimization: a
 * `select`-less `findUnique` on `ShopSettings` would pull the merchant's
 * notification email and fraud thresholds into a function whose return value is
 * one careless spread away from being serialized to a shopper.
 */

/** Exactly the shop fields the storefront needs, and nothing else. */
export type StorefrontShopRecord = Prisma.ShopGetPayload<{
  select: {
    id: true;
    domain: true;
    isActive: true;
    currencyCode: true;
    settings: {
      select: {
        codEnabled: true;
        replaceAddToCart: true;
        replaceBuyNow: true;
        enabledOnAllProducts: true;
        includedProductGids: true;
        excludedProductGids: true;
        includedCollectionGids: true;
        codFeeEnabled: true;
        codFeeAmount: true;
        codFeeIsPercent: true;
        shippingFee: true;
        freeShippingAbove: true;
        minOrderValue: true;
        maxOrderValue: true;
        brandPrimaryColor: true;
        brandSecondaryColor: true;
        brandTextColor: true;
        brandFontFamily: true;
        brandBorderRadius: true;
        brandLogoUrl: true;
        brandLogoHeight: true;
        brandLogoAlignment: true;
        customCss: true;
        themeMode: true;
        defaultLocale: true;
        enabledLocales: true;
        forceRtl: true;
      };
    };
    subscription: { select: { plan: true; status: true } };
  };
}>;

export function findShopForStorefront(domain: string): Promise<StorefrontShopRecord | null> {
  return prisma.shop.findUnique({
    where: { domain },
    select: {
      id: true,
      domain: true,
      isActive: true,
      currencyCode: true,
      settings: {
        select: {
          codEnabled: true,
          replaceAddToCart: true,
          replaceBuyNow: true,
          enabledOnAllProducts: true,
          includedProductGids: true,
          excludedProductGids: true,
          includedCollectionGids: true,
          codFeeEnabled: true,
          codFeeAmount: true,
          codFeeIsPercent: true,
          shippingFee: true,
          freeShippingAbove: true,
          minOrderValue: true,
          maxOrderValue: true,
          brandPrimaryColor: true,
          brandSecondaryColor: true,
          brandTextColor: true,
          brandFontFamily: true,
          brandBorderRadius: true,
          brandLogoUrl: true,
          brandLogoHeight: true,
          brandLogoAlignment: true,
          customCss: true,
          themeMode: true,
          defaultLocale: true,
          enabledLocales: true,
          forceRtl: true,
        },
      },
      subscription: { select: { plan: true, status: true } },
    },
  });
}

export type StorefrontButtonRecord = Prisma.ButtonConfigGetPayload<{
  select: {
    placement: true;
    label: true;
    subLabel: true;
    iconName: true;
    translations: true;
    bgColor: true;
    textColor: true;
    borderColor: true;
    borderRadius: true;
    fontSize: true;
    fontWeight: true;
    paddingY: true;
    paddingX: true;
    fullWidth: true;
    customCss: true;
    showOnMobile: true;
    showOnDesktop: true;
    showAfterScrollPx: true;
    stickyOffsetBottom: true;
    floatingPosition: true;
    openInPopup: true;
    animation: true;
  };
}>;

/** Enabled buttons only — a disabled placement should not reach the browser at all. */
export function findEnabledButtons(shopId: string): Promise<StorefrontButtonRecord[]> {
  return prisma.buttonConfig.findMany({
    where: { shopId, isEnabled: true },
    select: {
      placement: true,
      label: true,
      subLabel: true,
      iconName: true,
      translations: true,
      bgColor: true,
      textColor: true,
      borderColor: true,
      borderRadius: true,
      fontSize: true,
      fontWeight: true,
      paddingY: true,
      paddingX: true,
      fullWidth: true,
      customCss: true,
      showOnMobile: true,
      showOnDesktop: true,
      showAfterScrollPx: true,
      stickyOffsetBottom: true,
      floatingPosition: true,
      openInPopup: true,
      animation: true,
    },
    orderBy: { placement: 'asc' },
  });
}

/**
 * The shop's active COD form.
 *
 * Only the identifier and the OTP flag: the full field list is a separate,
 * lazily-fetched payload, because a page view that never opens the form should
 * not pay to download it.
 */
export function findActiveForm(
  shopId: string,
): Promise<{ id: string; requireOtp: boolean } | null> {
  return prisma.formConfig.findFirst({
    where: { shopId, isActive: true },
    select: { id: true, requireOtp: true },
    // A shop should only ever have one active form, but ordering makes the
    // choice deterministic if a bug or a partial write leaves two.
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });
}

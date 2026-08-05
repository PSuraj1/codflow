/**
 * Shop metadata queries.
 *
 * Kept as plain strings rather than generated documents: the app pins one API
 * version and these operations are small enough that a codegen step would cost
 * more than it saves. Every field selected here maps onto a column of the
 * `Shop` model — if you add one, add the column in the same commit.
 */

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query CodFlowShopInfo {
    shop {
      id
      name
      email
      myshopifyDomain
      ianaTimezone
      timezoneAbbreviation
      contactEmail
      billingAddress {
        countryCodeV2
        phone
      }
      currencyCode
      primaryDomain {
        url
      }
      plan {
        displayName
        partnerDevelopment
        shopifyPlus
      }
    }
  }
`;

export interface ShopInfoResponse {
  shop: {
    id: string;
    name: string;
    email: string | null;
    myshopifyDomain: string;
    ianaTimezone: string | null;
    timezoneAbbreviation: string | null;
    contactEmail: string | null;
    billingAddress: {
      countryCodeV2: string | null;
      phone: string | null;
    } | null;
    currencyCode: string;
    primaryDomain: { url: string } | null;
    plan: {
      displayName: string;
      partnerDevelopment: boolean;
      shopifyPlus: boolean;
    };
  };
}

/**
 * The shop's enabled locales, used to pre-populate `ShopSettings.enabledLocales`
 * so a multi-language storefront gets matching COD form translations by default
 * rather than English-only.
 */
export const SHOP_LOCALES_QUERY = /* GraphQL */ `
  query CodFlowShopLocales {
    shopLocales {
      locale
      primary
      published
    }
  }
`;

export interface ShopLocalesResponse {
  shopLocales: Array<{
    locale: string;
    primary: boolean;
    published: boolean;
  }>;
}

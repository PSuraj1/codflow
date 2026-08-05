/**
 * Enums mirrored from the Prisma schema.
 *
 * These are declared as const objects rather than TypeScript `enum` so they are
 * safe under `isolatedModules`, tree-shakeable in the admin bundle, and usable
 * from the web pixel sandbox (which has no Prisma client). The Prisma schema in
 * apps/api/prisma/schema.prisma is the source of truth — when a member changes
 * there, change it here in the same commit.
 */

export const Plan = {
  FREE: 'FREE',
  STARTER: 'STARTER',
  PRO: 'PRO',
  ENTERPRISE: 'ENTERPRISE',
} as const;
export type Plan = (typeof Plan)[keyof typeof Plan];

export const SubscriptionStatus = {
  ACTIVE: 'ACTIVE',
  TRIALING: 'TRIALING',
  FROZEN: 'FROZEN',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  PENDING: 'PENDING',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export const CodOrderStatus = {
  DRAFT: 'DRAFT',
  PENDING_OTP: 'PENDING_OTP',
  CONFIRMED: 'CONFIRMED',
  PUSHED_TO_SHOPIFY: 'PUSHED_TO_SHOPIFY',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  ABANDONED: 'ABANDONED',
  FULFILLED: 'FULFILLED',
  RETURNED: 'RETURNED',
  REFUNDED: 'REFUNDED',
} as const;
export type CodOrderStatus = (typeof CodOrderStatus)[keyof typeof CodOrderStatus];

export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RiskAction = {
  ALLOW: 'ALLOW',
  REVIEW: 'REVIEW',
  CHALLENGE_OTP: 'CHALLENGE_OTP',
  BLOCK: 'BLOCK',
} as const;
export type RiskAction = (typeof RiskAction)[keyof typeof RiskAction];

export const FormFieldType = {
  TEXT: 'TEXT',
  TEXTAREA: 'TEXTAREA',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  NUMBER: 'NUMBER',
  SELECT: 'SELECT',
  MULTISELECT: 'MULTISELECT',
  RADIO: 'RADIO',
  CHECKBOX: 'CHECKBOX',
  COUNTRY: 'COUNTRY',
  STATE: 'STATE',
  CITY: 'CITY',
  POSTAL_CODE: 'POSTAL_CODE',
  DATE: 'DATE',
  HIDDEN: 'HIDDEN',
  HEADING: 'HEADING',
  PARAGRAPH: 'PARAGRAPH',
  DIVIDER: 'DIVIDER',
  QUANTITY: 'QUANTITY',
  VARIANT_PICKER: 'VARIANT_PICKER',
  CONSENT: 'CONSENT',
} as const;
export type FormFieldType = (typeof FormFieldType)[keyof typeof FormFieldType];

/** Field types that render as presentation only — they never produce a value. */
export const PRESENTATIONAL_FIELD_TYPES: readonly FormFieldType[] = [
  FormFieldType.HEADING,
  FormFieldType.PARAGRAPH,
  FormFieldType.DIVIDER,
];

export const ButtonPlacement = {
  PRODUCT_PAGE: 'PRODUCT_PAGE',
  CART_PAGE: 'CART_PAGE',
  STICKY_MOBILE: 'STICKY_MOBILE',
  FLOATING: 'FLOATING',
  POPUP: 'POPUP',
  COLLECTION_PAGE: 'COLLECTION_PAGE',
  HOME_PAGE: 'HOME_PAGE',
} as const;
export type ButtonPlacement = (typeof ButtonPlacement)[keyof typeof ButtonPlacement];

export const PixelProvider = {
  META: 'META',
  TIKTOK: 'TIKTOK',
  GOOGLE_ADS: 'GOOGLE_ADS',
  SNAPCHAT: 'SNAPCHAT',
  PINTEREST: 'PINTEREST',
  CUSTOM: 'CUSTOM',
} as const;
export type PixelProvider = (typeof PixelProvider)[keyof typeof PixelProvider];

export const PixelEventName = {
  PAGE_VIEW: 'PAGE_VIEW',
  VIEW_CONTENT: 'VIEW_CONTENT',
  ADD_TO_CART: 'ADD_TO_CART',
  INITIATE_CHECKOUT: 'INITIATE_CHECKOUT',
  ADD_PAYMENT_INFO: 'ADD_PAYMENT_INFO',
  PURCHASE: 'PURCHASE',
  LEAD: 'LEAD',
  COMPLETE_REGISTRATION: 'COMPLETE_REGISTRATION',
  SEARCH: 'SEARCH',
  CUSTOM: 'CUSTOM',
} as const;
export type PixelEventName = (typeof PixelEventName)[keyof typeof PixelEventName];

export const PixelDispatchStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED_CONSENT: 'SKIPPED_CONSENT',
  DEDUPLICATED: 'DEDUPLICATED',
  SKIPPED: 'SKIPPED',
} as const;
export type PixelDispatchStatus = (typeof PixelDispatchStatus)[keyof typeof PixelDispatchStatus];

export const SyncStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  RETRYING: 'RETRYING',
} as const;
export type SyncStatus = (typeof SyncStatus)[keyof typeof SyncStatus];

export const SyncTrigger = {
  WEBHOOK: 'WEBHOOK',
  MANUAL: 'MANUAL',
  BULK: 'BULK',
  RETRY: 'RETRY',
  SCHEDULED: 'SCHEDULED',
  REALTIME: 'REALTIME',
} as const;
export type SyncTrigger = (typeof SyncTrigger)[keyof typeof SyncTrigger];

export const OtpProvider = {
  FIREBASE: 'FIREBASE',
  MSG91: 'MSG91',
  TWILIO: 'TWILIO',
  WHATSAPP: 'WHATSAPP',
  SMTP_EMAIL: 'SMTP_EMAIL',
} as const;
export type OtpProvider = (typeof OtpProvider)[keyof typeof OtpProvider];

export const OtpStatus = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type OtpStatus = (typeof OtpStatus)[keyof typeof OtpStatus];

export const BlockListType = {
  BLACKLIST: 'BLACKLIST',
  WHITELIST: 'WHITELIST',
} as const;
export type BlockListType = (typeof BlockListType)[keyof typeof BlockListType];

export const BlockListScope = {
  PHONE: 'PHONE',
  EMAIL: 'EMAIL',
  IP: 'IP',
  ADDRESS: 'ADDRESS',
  POSTAL_CODE: 'POSTAL_CODE',
  COUNTRY: 'COUNTRY',
  CUSTOMER_ID: 'CUSTOMER_ID',
  DEVICE_FINGERPRINT: 'DEVICE_FINGERPRINT',
} as const;
export type BlockListScope = (typeof BlockListScope)[keyof typeof BlockListScope];

export const AutomationTrigger = {
  COD_ORDER_CREATED: 'COD_ORDER_CREATED',
  COD_ORDER_CONFIRMED: 'COD_ORDER_CONFIRMED',
  ORDER_PUSHED: 'ORDER_PUSHED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_FULFILLED: 'ORDER_FULFILLED',
  ORDER_RETURNED: 'ORDER_RETURNED',
  HIGH_RISK_DETECTED: 'HIGH_RISK_DETECTED',
  OTP_VERIFIED: 'OTP_VERIFIED',
  OTP_FAILED: 'OTP_FAILED',
  SYNC_FAILED: 'SYNC_FAILED',
  ABANDONED_COD: 'ABANDONED_COD',
} as const;
export type AutomationTrigger = (typeof AutomationTrigger)[keyof typeof AutomationTrigger];

export const AutomationActionType = {
  ADD_ORDER_TAG: 'ADD_ORDER_TAG',
  REMOVE_ORDER_TAG: 'REMOVE_ORDER_TAG',
  ARCHIVE_ORDER: 'ARCHIVE_ORDER',
  CANCEL_ORDER: 'CANCEL_ORDER',
  SEND_EMAIL: 'SEND_EMAIL',
  SEND_WHATSAPP: 'SEND_WHATSAPP',
  SYNC_TO_SHEET: 'SYNC_TO_SHEET',
  FIRE_PIXEL_EVENT: 'FIRE_PIXEL_EVENT',
  RUN_FRAUD_SCAN: 'RUN_FRAUD_SCAN',
  ADD_TO_BLACKLIST: 'ADD_TO_BLACKLIST',
  ADD_CUSTOMER_TAG: 'ADD_CUSTOMER_TAG',
  WEBHOOK_POST: 'WEBHOOK_POST',
} as const;
export type AutomationActionType = (typeof AutomationActionType)[keyof typeof AutomationActionType];

export const NotificationChannel = {
  EMAIL: 'EMAIL',
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
  WEBHOOK: 'WEBHOOK',
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const Locale = {
  EN: 'EN',
  HI: 'HI',
  AR: 'AR',
  FR: 'FR',
  ES: 'ES',
  DE: 'DE',
} as const;
export type Locale = (typeof Locale)[keyof typeof Locale];

export const ThemeMode = {
  LIGHT: 'LIGHT',
  DARK: 'DARK',
  SYSTEM: 'SYSTEM',
} as const;
export type ThemeMode = (typeof ThemeMode)[keyof typeof ThemeMode];

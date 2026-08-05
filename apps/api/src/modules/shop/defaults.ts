import {
  ButtonPlacement,
  FormFieldType,
  NotificationChannel,
  type Prisma,
} from '@prisma/client';

/**
 * The records every shop receives at install.
 *
 * This module is the single source of truth for that data. Both the
 * provisioning service (which runs on a real install) and `prisma/seed.ts`
 * (which runs against a dev database) read from here, so a merchant's first
 * experience and a developer's local database cannot drift apart.
 *
 * Deliberately dependency-free apart from Prisma's generated types: the seed
 * runs via `tsx` without a full environment, so anything that transitively
 * imports `config/env` would make seeding require production-shaped secrets.
 */

/** Gaps of 10 leave room to drag a field between two others without renumbering siblings. */
export const FIELD_POSITION_STEP = 10;

export interface DefaultFormField {
  key: string;
  type: FormFieldType;
  label: string;
  placeholder?: string;
  helpText?: string;
  isRequired: boolean;
  /** System fields may be reordered, relabelled and disabled — never deleted. */
  isSystem: boolean;
  columnWidth: number;
  minLength?: number;
  maxLength?: number;
  regexPattern?: string;
  validationMessage?: string;
}

/**
 * Default COD form, in render order.
 *
 * The order is chosen for completion rate, not for tidiness: phone comes before
 * address because a partially-filled form with a phone number is still a
 * recoverable lead, while one with an address and no phone is not.
 */
export const DEFAULT_FORM_FIELDS: readonly DefaultFormField[] = [
  {
    key: 'firstName',
    type: FormFieldType.TEXT,
    label: 'First name',
    placeholder: 'John',
    isRequired: true,
    isSystem: true,
    columnWidth: 6,
    maxLength: 60,
  },
  {
    key: 'lastName',
    type: FormFieldType.TEXT,
    label: 'Last name',
    placeholder: 'Doe',
    isRequired: false,
    isSystem: true,
    columnWidth: 6,
    maxLength: 60,
  },
  {
    key: 'phone',
    type: FormFieldType.PHONE,
    label: 'Phone number',
    placeholder: '+91 98765 43210',
    helpText: 'We will call this number to confirm your order.',
    isRequired: true,
    isSystem: true,
    columnWidth: 12,
    // Loose on purpose: authoritative validation is libphonenumber-js
    // server-side, which knows per-country rules. This only blocks obvious junk.
    regexPattern: '^[+]?[0-9\\s\\-()]{7,20}$',
    validationMessage: 'Enter a valid phone number.',
  },
  {
    key: 'email',
    type: FormFieldType.EMAIL,
    label: 'Email',
    placeholder: 'you@example.com',
    helpText: 'Optional — used to send your order confirmation.',
    isRequired: false,
    isSystem: true,
    columnWidth: 12,
    maxLength: 200,
  },
  {
    key: 'address1',
    type: FormFieldType.TEXT,
    label: 'Address',
    placeholder: 'House / flat number, street',
    isRequired: true,
    isSystem: true,
    columnWidth: 12,
    maxLength: 255,
  },
  {
    key: 'address2',
    type: FormFieldType.TEXT,
    label: 'Apartment, landmark (optional)',
    isRequired: false,
    isSystem: false,
    columnWidth: 12,
    maxLength: 255,
  },
  {
    key: 'city',
    type: FormFieldType.CITY,
    label: 'City',
    isRequired: true,
    isSystem: true,
    columnWidth: 6,
    maxLength: 100,
  },
  {
    key: 'province',
    type: FormFieldType.STATE,
    label: 'State / province',
    isRequired: true,
    isSystem: true,
    columnWidth: 6,
    maxLength: 100,
  },
  {
    key: 'postalCode',
    type: FormFieldType.POSTAL_CODE,
    label: 'PIN / postal code',
    isRequired: true,
    isSystem: true,
    columnWidth: 6,
    maxLength: 20,
  },
  {
    key: 'country',
    type: FormFieldType.COUNTRY,
    label: 'Country',
    isRequired: true,
    isSystem: true,
    columnWidth: 6,
  },
  {
    key: 'orderNotes',
    type: FormFieldType.TEXTAREA,
    label: 'Order notes (optional)',
    placeholder: 'Delivery instructions, preferred time…',
    isRequired: false,
    isSystem: false,
    columnWidth: 12,
    maxLength: 1000,
  },
];

export interface DefaultButtonConfig {
  placement: ButtonPlacement;
  isEnabled: boolean;
  label: string;
  showOnMobile: boolean;
  showOnDesktop: boolean;
  floatingPosition?: string;
  showAfterScrollPx?: number;
}

/**
 * One row per placement the merchant can turn on later.
 *
 * Only the product-page and sticky-mobile buttons start enabled. Switching on
 * every placement at install would put four COD buttons on one product page,
 * which merchants reasonably read as the app breaking their theme.
 */
export const DEFAULT_BUTTON_CONFIGS: readonly DefaultButtonConfig[] = [
  {
    placement: ButtonPlacement.PRODUCT_PAGE,
    isEnabled: true,
    label: 'Order Now — Cash On Delivery',
    showOnMobile: true,
    showOnDesktop: true,
  },
  {
    placement: ButtonPlacement.STICKY_MOBILE,
    isEnabled: true,
    label: 'Cash On Delivery',
    showOnMobile: true,
    showOnDesktop: false,
    showAfterScrollPx: 300,
  },
  {
    placement: ButtonPlacement.CART_PAGE,
    isEnabled: false,
    label: 'Checkout with Cash On Delivery',
    showOnMobile: true,
    showOnDesktop: true,
  },
  {
    placement: ButtonPlacement.FLOATING,
    isEnabled: false,
    label: 'Order COD',
    showOnMobile: true,
    showOnDesktop: false,
    floatingPosition: 'bottom_right',
    showAfterScrollPx: 500,
  },
];

/**
 * Style and behaviour a button starts with.
 *
 * Mirrors the column defaults on `ButtonConfig`, and exists because those
 * defaults only materialize once a row is written. `DEFAULT_BUTTON_CONFIGS`
 * creates four rows at install; the customizer has to show all six renderable
 * placements, so it needs a complete record for the two that have none.
 *
 * Keep this in step with the schema. They are checked against each other by
 * `modules/buttons/service.test.ts` only insofar as the shapes agree — a drifted
 * *value* would show a merchant one default and save another.
 */
export const DEFAULT_BUTTON_STYLE = {
  label: 'Order Now — Cash On Delivery',
  subLabel: null,
  bgColor: '#008060',
  textColor: '#FFFFFF',
  borderColor: '#008060',
  borderRadius: 8,
  fontSize: 16,
  fontWeight: '600',
  paddingY: 14,
  paddingX: 24,
  fullWidth: true,
  customCss: null,
  showOnMobile: true,
  showOnDesktop: true,
  showAfterScrollPx: 0,
  stickyOffsetBottom: 0,
  floatingPosition: 'bottom_right',
  animation: 'none',
} as const;

export interface DefaultNotificationTemplate {
  key: string;
  channel: NotificationChannel;
  subject: string;
  body: string;
}

/** `{{token}}` placeholders are resolved by the notification service. */
export const DEFAULT_NOTIFICATION_TEMPLATES: readonly DefaultNotificationTemplate[] = [
  {
    key: 'cod_order_confirmation',
    channel: NotificationChannel.EMAIL,
    subject: 'Your order {{reference}} is confirmed',
    body:
      'Hi {{firstName}},\n\n' +
      'Thanks for your order at {{shopName}}.\n\n' +
      'Reference: {{reference}}\n' +
      'Total (payable on delivery): {{total}} {{currency}}\n\n' +
      'Delivery address:\n{{address1}}, {{city}}, {{province}} {{postalCode}}\n\n' +
      'We will call {{phone}} to confirm before dispatch.',
  },
  {
    key: 'merchant_new_order',
    channel: NotificationChannel.EMAIL,
    subject: '[COD] New order {{reference}} — {{total}} {{currency}}',
    body:
      'New cash-on-delivery order.\n\n' +
      'Reference: {{reference}}\n' +
      'Customer: {{firstName}} {{lastName}} ({{phone}})\n' +
      'Total: {{total}} {{currency}}\n' +
      'Risk: {{riskLevel}} ({{riskScore}}/100)',
  },
  {
    key: 'high_risk_alert',
    channel: NotificationChannel.EMAIL,
    subject: '[COD] High-risk order flagged — {{reference}}',
    body:
      'Order {{reference}} scored {{riskScore}}/100 ({{riskLevel}}).\n\n' +
      'Triggered signals:\n{{signals}}\n\n' +
      'Action taken: {{riskAction}}',
  },
  {
    key: 'sync_failure_alert',
    channel: NotificationChannel.EMAIL,
    subject: '[CodFlow] Google Sheets sync is failing',
    body:
      'Order {{reference}} could not be written to your Google Sheet.\n\n' +
      'Error: {{errorMessage}}\n\n' +
      'Failed syncs retry automatically. If this persists, reconnect your ' +
      'Google account in CodFlow → Settings → Google Sheets.',
  },
];

export const DEFAULT_FORM_NAME = 'Default COD Form';

/** Copy for the default form. Separated so provisioning and the seed agree. */
export const DEFAULT_FORM_CONFIG = {
  name: DEFAULT_FORM_NAME,
  isActive: true,
  isDefault: true,
  headingText: 'Cash On Delivery',
  subheadingText: 'Pay when your order arrives. No advance payment.',
  submitButtonText: 'Place Order',
  successMessage: 'Thank you! We will call you shortly to confirm.',
} satisfies Omit<Prisma.FormConfigCreateWithoutShopInput, 'fields'>;

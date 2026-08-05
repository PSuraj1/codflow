-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'FROZEN', 'CANCELLED', 'EXPIRED', 'PENDING');

-- CreateEnum
CREATE TYPE "CodOrderStatus" AS ENUM ('DRAFT', 'PENDING_OTP', 'CONFIRMED', 'PUSHED_TO_SHOPIFY', 'FAILED', 'CANCELLED', 'ABANDONED', 'FULFILLED', 'RETURNED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskAction" AS ENUM ('ALLOW', 'REVIEW', 'CHALLENGE_OTP', 'BLOCK');

-- CreateEnum
CREATE TYPE "FormFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'NUMBER', 'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'COUNTRY', 'STATE', 'CITY', 'POSTAL_CODE', 'DATE', 'HIDDEN', 'HEADING', 'PARAGRAPH', 'DIVIDER', 'QUANTITY', 'VARIANT_PICKER', 'CONSENT');

-- CreateEnum
CREATE TYPE "ButtonPlacement" AS ENUM ('PRODUCT_PAGE', 'CART_PAGE', 'STICKY_MOBILE', 'FLOATING', 'POPUP', 'COLLECTION_PAGE', 'HOME_PAGE');

-- CreateEnum
CREATE TYPE "PixelProvider" AS ENUM ('META', 'TIKTOK', 'GOOGLE_ADS', 'SNAPCHAT', 'PINTEREST', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PixelEventName" AS ENUM ('PAGE_VIEW', 'VIEW_CONTENT', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'ADD_PAYMENT_INFO', 'PURCHASE', 'LEAD', 'COMPLETE_REGISTRATION', 'SEARCH', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PixelDispatchStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_CONSENT', 'DEDUPLICATED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED', 'RETRYING');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('WEBHOOK', 'MANUAL', 'BULK', 'RETRY', 'SCHEDULED', 'REALTIME');

-- CreateEnum
CREATE TYPE "OtpProvider" AS ENUM ('FIREBASE', 'MSG91', 'TWILIO', 'WHATSAPP', 'SMTP_EMAIL');

-- CreateEnum
CREATE TYPE "OtpStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BlockListType" AS ENUM ('BLACKLIST', 'WHITELIST');

-- CreateEnum
CREATE TYPE "BlockListScope" AS ENUM ('PHONE', 'EMAIL', 'IP', 'ADDRESS', 'POSTAL_CODE', 'COUNTRY', 'CUSTOMER_ID', 'DEVICE_FINGERPRINT');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('COD_ORDER_CREATED', 'COD_ORDER_CONFIRMED', 'ORDER_PUSHED', 'ORDER_CANCELLED', 'ORDER_FULFILLED', 'ORDER_RETURNED', 'HIGH_RISK_DETECTED', 'OTP_VERIFIED', 'OTP_FAILED', 'SYNC_FAILED', 'ABANDONED_COD');

-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('ADD_ORDER_TAG', 'REMOVE_ORDER_TAG', 'ARCHIVE_ORDER', 'CANCEL_ORDER', 'SEND_EMAIL', 'SEND_WHATSAPP', 'SYNC_TO_SHEET', 'FIRE_PIXEL_EVENT', 'RUN_FRAUD_SCAN', 'ADD_TO_BLACKLIST', 'ADD_CUSTOMER_TAG', 'WEBHOOK_POST');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'SMS', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('EN', 'HI', 'AR', 'FR', 'ES', 'DE');

-- CreateEnum
CREATE TYPE "ThemeMode" AS ENUM ('LIGHT', 'DARK', 'SYSTEM');

-- CreateTable
CREATE TABLE "shopify_sessions" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN,
    "locale" TEXT,
    "collaborator" BOOLEAN,
    "emailVerified" BOOLEAN,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "shopify_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "shopifyGid" TEXT,
    "name" TEXT,
    "email" TEXT,
    "ownerName" TEXT,
    "phone" TEXT,
    "countryCode" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "primaryLocale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "ianaTimezone" TEXT,
    "planDisplayName" TEXT,
    "shopifyPlan" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "grantedScopes" TEXT,
    "onboardingCompletedAt" TIMESTAMP(3),
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_settings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "codEnabled" BOOLEAN NOT NULL DEFAULT true,
    "replaceAddToCart" BOOLEAN NOT NULL DEFAULT false,
    "replaceBuyNow" BOOLEAN NOT NULL DEFAULT true,
    "enabledOnAllProducts" BOOLEAN NOT NULL DEFAULT true,
    "includedProductGids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedProductGids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includedCollectionGids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codFeeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "codFeeAmount" DECIMAL(12,2),
    "codFeeIsPercent" BOOLEAN NOT NULL DEFAULT false,
    "minOrderValue" DECIMAL(12,2),
    "maxOrderValue" DECIMAL(12,2),
    "freeShippingAbove" DECIMAL(12,2),
    "shippingFee" DECIMAL(12,2),
    "defaultOrderTags" TEXT[] DEFAULT ARRAY['COD', 'CodFlow']::TEXT[],
    "createAsDraftOrder" BOOLEAN NOT NULL DEFAULT false,
    "autoFulfill" BOOLEAN NOT NULL DEFAULT false,
    "markAsPaid" BOOLEAN NOT NULL DEFAULT false,
    "inventoryBehaviour" TEXT NOT NULL DEFAULT 'decrement_obeying_policy',
    "sendShopifyOrderConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "brandPrimaryColor" TEXT NOT NULL DEFAULT '#008060',
    "brandSecondaryColor" TEXT NOT NULL DEFAULT '#004C3F',
    "brandTextColor" TEXT NOT NULL DEFAULT '#202223',
    "brandFontFamily" TEXT NOT NULL DEFAULT 'inherit',
    "brandBorderRadius" INTEGER NOT NULL DEFAULT 8,
    "brandLogoUrl" TEXT,
    "customCss" TEXT,
    "themeMode" "ThemeMode" NOT NULL DEFAULT 'SYSTEM',
    "defaultLocale" "Locale" NOT NULL DEFAULT 'EN',
    "enabledLocales" "Locale"[] DEFAULT ARRAY['EN']::"Locale"[],
    "forceRtl" BOOLEAN NOT NULL DEFAULT false,
    "currencyFormat" TEXT NOT NULL DEFAULT '{{amount}} {{currency}}',
    "dateFormat" TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
    "allowedCountryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedCountryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedPostalPatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedPostalPatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notifyEmail" TEXT,
    "notifyOnNewOrder" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnHighRisk" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnSyncFailure" BOOLEAN NOT NULL DEFAULT true,
    "customerEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_configs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default COD Form',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "headingText" TEXT NOT NULL DEFAULT 'Cash On Delivery',
    "subheadingText" TEXT,
    "submitButtonText" TEXT NOT NULL DEFAULT 'Place Order',
    "successMessage" TEXT NOT NULL DEFAULT 'Thank you! Your order has been placed.',
    "translations" JSONB NOT NULL DEFAULT '{}',
    "layout" TEXT NOT NULL DEFAULT 'single_column',
    "showOrderSummary" BOOLEAN NOT NULL DEFAULT true,
    "showProductImage" BOOLEAN NOT NULL DEFAULT true,
    "showQuantitySelector" BOOLEAN NOT NULL DEFAULT true,
    "showVariantSelector" BOOLEAN NOT NULL DEFAULT true,
    "showCouponField" BOOLEAN NOT NULL DEFAULT false,
    "showTermsCheckbox" BOOLEAN NOT NULL DEFAULT false,
    "termsUrl" TEXT,
    "requireOtp" BOOLEAN NOT NULL DEFAULT false,
    "trackAbandonment" BOOLEAN NOT NULL DEFAULT true,
    "abandonmentDelaySeconds" INTEGER NOT NULL DEFAULT 30,
    "botProtection" BOOLEAN NOT NULL DEFAULT true,
    "minFillSeconds" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_fields" (
    "id" TEXT NOT NULL,
    "formConfigId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "FormFieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "placeholder" TEXT,
    "helpText" TEXT,
    "position" INTEGER NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "minLength" INTEGER,
    "maxLength" INTEGER,
    "minValue" DECIMAL(12,2),
    "maxValue" DECIMAL(12,2),
    "regexPattern" TEXT,
    "validationMessage" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "conditionalOn" JSONB,
    "columnWidth" INTEGER NOT NULL DEFAULT 12,
    "cssClass" TEXT,
    "translations" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "button_configs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "placement" "ButtonPlacement" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT NOT NULL DEFAULT 'Order Now — Cash On Delivery',
    "subLabel" TEXT,
    "iconName" TEXT,
    "translations" JSONB NOT NULL DEFAULT '{}',
    "bgColor" TEXT NOT NULL DEFAULT '#008060',
    "textColor" TEXT NOT NULL DEFAULT '#FFFFFF',
    "borderColor" TEXT NOT NULL DEFAULT '#008060',
    "borderRadius" INTEGER NOT NULL DEFAULT 8,
    "fontSize" INTEGER NOT NULL DEFAULT 16,
    "fontWeight" TEXT NOT NULL DEFAULT '600',
    "paddingY" INTEGER NOT NULL DEFAULT 14,
    "paddingX" INTEGER NOT NULL DEFAULT 24,
    "fullWidth" BOOLEAN NOT NULL DEFAULT true,
    "customCss" TEXT,
    "stickyOffsetBottom" INTEGER NOT NULL DEFAULT 0,
    "floatingPosition" TEXT NOT NULL DEFAULT 'bottom_right',
    "showOnMobile" BOOLEAN NOT NULL DEFAULT true,
    "showOnDesktop" BOOLEAN NOT NULL DEFAULT true,
    "showAfterScrollPx" INTEGER NOT NULL DEFAULT 0,
    "openInPopup" BOOLEAN NOT NULL DEFAULT true,
    "animation" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "button_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_orders" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "CodOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "shopifyOrderGid" TEXT,
    "shopifyOrderNumber" TEXT,
    "shopifyDraftOrderGid" TEXT,
    "shopifyCustomerGid" TEXT,
    "pushedAt" TIMESTAMP(3),
    "pushAttempts" INTEGER NOT NULL DEFAULT 0,
    "pushError" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "phoneE164" TEXT,
    "address1" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "provinceCode" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "postalCode" TEXT,
    "addressHash" TEXT,
    "orderNotes" TEXT,
    "lineItems" JSONB NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "codFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountCode" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "landingPage" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "deviceFingerprint" TEXT,
    "clientId" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "ttclid" TEXT,
    "gclid" TEXT,
    "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "analyticsConsent" BOOLEAN NOT NULL DEFAULT false,
    "saleOfDataConsent" BOOLEAN NOT NULL DEFAULT false,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "riskAction" "RiskAction" NOT NULL DEFAULT 'ALLOW',
    "otpRequired" BOOLEAN NOT NULL DEFAULT false,
    "otpVerified" BOOLEAN NOT NULL DEFAULT false,
    "otpVerifiedAt" TIMESTAMP(3),
    "sheetSyncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "sheetSyncedAt" TIMESTAMP(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "internalNote" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cod_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cod_order_events" (
    "id" TEXT NOT NULL,
    "codOrderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL DEFAULT 'system',
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_accounts" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "googleUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRefreshedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_configs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "googleAccountId" TEXT NOT NULL,
    "spreadsheetId" TEXT NOT NULL,
    "spreadsheetName" TEXT,
    "spreadsheetUrl" TEXT,
    "worksheetName" TEXT NOT NULL DEFAULT 'CodFlow Orders',
    "worksheetGid" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoSync" BOOLEAN NOT NULL DEFAULT true,
    "includeHeaders" BOOLEAN NOT NULL DEFAULT true,
    "writeMode" TEXT NOT NULL DEFAULT 'append',
    "columnMapping" JSONB NOT NULL DEFAULT '[]',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" "SyncStatus",
    "lastError" TEXT,
    "nextRow" INTEGER NOT NULL DEFAULT 2,
    "totalSynced" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sheet_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sheet_sync_logs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sheetConfigId" TEXT,
    "codOrderId" TEXT,
    "status" "SyncStatus" NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "rowNumber" INTEGER,
    "payload" JSONB,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sheet_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pixels" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" "PixelProvider" NOT NULL,
    "label" TEXT NOT NULL,
    "pixelId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "serverSideEnabled" BOOLEAN NOT NULL DEFAULT false,
    "accessTokenEnc" TEXT,
    "testEventCode" TEXT,
    "conversionLabel" TEXT,
    "conversionId" TEXT,
    "gtmContainerId" TEXT,
    "clientSideEnabled" BOOLEAN NOT NULL DEFAULT true,
    "advancedMatching" BOOLEAN NOT NULL DEFAULT true,
    "deduplication" BOOLEAN NOT NULL DEFAULT true,
    "enabledEvents" "PixelEventName"[] DEFAULT ARRAY[]::"PixelEventName"[],
    "eventMapping" JSONB NOT NULL DEFAULT '{}',
    "customScript" TEXT,
    "requireConsent" BOOLEAN NOT NULL DEFAULT true,
    "lastEventAt" TIMESTAMP(3),
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pixels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pixel_events" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "pixelId" TEXT,
    "codOrderId" TEXT,
    "eventName" "PixelEventName" NOT NULL,
    "customEventName" TEXT,
    "eventId" TEXT NOT NULL,
    "status" "PixelDispatchStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "payload" JSONB,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "value" DECIMAL(12,2),
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pixel_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_settings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mediumThreshold" INTEGER NOT NULL DEFAULT 30,
    "highThreshold" INTEGER NOT NULL DEFAULT 60,
    "criticalThreshold" INTEGER NOT NULL DEFAULT 85,
    "actionOnMedium" "RiskAction" NOT NULL DEFAULT 'REVIEW',
    "actionOnHigh" "RiskAction" NOT NULL DEFAULT 'CHALLENGE_OTP',
    "actionOnCritical" "RiskAction" NOT NULL DEFAULT 'BLOCK',
    "checkDuplicatePhone" BOOLEAN NOT NULL DEFAULT true,
    "checkDuplicateEmail" BOOLEAN NOT NULL DEFAULT true,
    "checkDuplicateAddress" BOOLEAN NOT NULL DEFAULT true,
    "checkDisposableEmail" BOOLEAN NOT NULL DEFAULT true,
    "checkFakePhone" BOOLEAN NOT NULL DEFAULT true,
    "checkVpn" BOOLEAN NOT NULL DEFAULT false,
    "checkProxy" BOOLEAN NOT NULL DEFAULT false,
    "checkTor" BOOLEAN NOT NULL DEFAULT true,
    "checkVelocity" BOOLEAN NOT NULL DEFAULT true,
    "checkCountryRisk" BOOLEAN NOT NULL DEFAULT false,
    "checkIpReputation" BOOLEAN NOT NULL DEFAULT false,
    "checkBlockList" BOOLEAN NOT NULL DEFAULT true,
    "maxOrdersPerDayPerPhone" INTEGER NOT NULL DEFAULT 3,
    "maxOrdersPerDayPerIp" INTEGER NOT NULL DEFAULT 5,
    "maxOrdersPerDayPerEmail" INTEGER NOT NULL DEFAULT 3,
    "maxOpenCodOrders" INTEGER NOT NULL DEFAULT 3,
    "velocityWindowMinutes" INTEGER NOT NULL DEFAULT 60,
    "velocityMaxOrders" INTEGER NOT NULL DEFAULT 3,
    "duplicateWindowHours" INTEGER NOT NULL DEFAULT 24,
    "highRiskCountryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipIntelProvider" TEXT,
    "ipIntelApiKeyEnc" TEXT,
    "autoBlacklistAfterFailures" INTEGER NOT NULL DEFAULT 0,
    "tagHighRiskOrders" BOOLEAN NOT NULL DEFAULT true,
    "highRiskTag" TEXT NOT NULL DEFAULT 'CodFlow-High-Risk',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_rules" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB NOT NULL,
    "scoreDelta" INTEGER NOT NULL DEFAULT 0,
    "action" "RiskAction",
    "reason" TEXT,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fraud_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_assessments" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "codOrderId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" "RiskLevel" NOT NULL,
    "action" "RiskAction" NOT NULL,
    "signals" JSONB NOT NULL,
    "matchedRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipCountryCode" TEXT,
    "ipIsVpn" BOOLEAN,
    "ipIsProxy" BOOLEAN,
    "ipIsTor" BOOLEAN,
    "ipIsHosting" BOOLEAN,
    "ipReputationScore" INTEGER,
    "emailIsDisposable" BOOLEAN,
    "phoneIsValid" BOOLEAN,
    "phoneCarrier" TEXT,
    "phoneLineType" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewDecision" "RiskAction",
    "reviewNote" TEXT,
    "engineVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "block_list_entries" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "BlockListType" NOT NULL,
    "scope" "BlockListScope" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'merchant',
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "block_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_settings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" "OtpProvider" NOT NULL DEFAULT 'MSG91',
    "fallbackProvider" "OtpProvider",
    "alwaysRequire" BOOLEAN NOT NULL DEFAULT false,
    "codeLength" INTEGER NOT NULL DEFAULT 6,
    "codeType" TEXT NOT NULL DEFAULT 'numeric',
    "expirySeconds" INTEGER NOT NULL DEFAULT 300,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "resendCooldownSeconds" INTEGER NOT NULL DEFAULT 30,
    "maxResends" INTEGER NOT NULL DEFAULT 3,
    "messageTemplate" TEXT NOT NULL DEFAULT 'Your {{shop}} verification code is {{code}}. Valid for {{minutes}} minutes.',
    "senderId" TEXT,
    "translations" JSONB NOT NULL DEFAULT '{}',
    "msg91AuthKeyEnc" TEXT,
    "msg91TemplateId" TEXT,
    "twilioAccountSid" TEXT,
    "twilioAuthTokenEnc" TEXT,
    "twilioFromNumber" TEXT,
    "twilioServiceSid" TEXT,
    "firebaseProjectId" TEXT,
    "firebaseServiceAccountEnc" TEXT,
    "whatsappPhoneNumberId" TEXT,
    "whatsappTokenEnc" TEXT,
    "whatsappTemplateName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "otp_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_verifications" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "codOrderId" TEXT,
    "destination" TEXT NOT NULL,
    "channel" "OtpProvider" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "status" "OtpStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "providerMessageId" TEXT,
    "providerResponse" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "otp_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "AutomationTrigger" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "conditions" JSONB,
    "actions" JSONB NOT NULL,
    "delaySeconds" INTEGER NOT NULL DEFAULT 0,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "codOrderId" TEXT,
    "status" "SyncStatus" NOT NULL,
    "trigger" "AutomationTrigger" NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "translations" JSONB NOT NULL DEFAULT '{}',
    "fromName" TEXT,
    "fromEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "planHandle" TEXT,
    "shopifySubscriptionGid" TEXT,
    "price" DECIMAL(10,2),
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "interval" TEXT NOT NULL DEFAULT 'EVERY_30_DAYS',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "limitAtTime" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_stats" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "formViews" INTEGER NOT NULL DEFAULT 0,
    "formStarts" INTEGER NOT NULL DEFAULT 0,
    "formSubmissions" INTEGER NOT NULL DEFAULT 0,
    "buttonClicks" INTEGER NOT NULL DEFAULT 0,
    "codOrders" INTEGER NOT NULL DEFAULT 0,
    "confirmedOrders" INTEGER NOT NULL DEFAULT 0,
    "pushedOrders" INTEGER NOT NULL DEFAULT 0,
    "cancelledOrders" INTEGER NOT NULL DEFAULT 0,
    "returnedOrders" INTEGER NOT NULL DEFAULT 0,
    "fulfilledOrders" INTEGER NOT NULL DEFAULT 0,
    "abandonedOrders" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cancelledValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "averageOrderValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "blockedAttempts" INTEGER NOT NULL DEFAULT 0,
    "highRiskOrders" INTEGER NOT NULL DEFAULT 0,
    "otpSent" INTEGER NOT NULL DEFAULT 0,
    "otpVerified" INTEGER NOT NULL DEFAULT 0,
    "otpFailed" INTEGER NOT NULL DEFAULT 0,
    "sheetSyncSuccess" INTEGER NOT NULL DEFAULT 0,
    "sheetSyncFailed" INTEGER NOT NULL DEFAULT 0,
    "pixelEventsSent" INTEGER NOT NULL DEFAULT 0,
    "pixelEventsFailed" INTEGER NOT NULL DEFAULT 0,
    "ordersByCountry" JSONB NOT NULL DEFAULT '{}',
    "ordersByCity" JSONB NOT NULL DEFAULT '{}',
    "ordersByProduct" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shopifyWebhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "apiVersion" TEXT,
    "triggeredAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'merchant',
    "actorId" TEXT,
    "actorEmail" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shopify_sessions_shop_idx" ON "shopify_sessions"("shop");

-- CreateIndex
CREATE INDEX "shopify_sessions_expires_idx" ON "shopify_sessions"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "shops_domain_key" ON "shops"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopifyGid_key" ON "shops"("shopifyGid");

-- CreateIndex
CREATE INDEX "shops_isActive_idx" ON "shops"("isActive");

-- CreateIndex
CREATE INDEX "shops_installedAt_idx" ON "shops"("installedAt");

-- CreateIndex
CREATE UNIQUE INDEX "shop_settings_shopId_key" ON "shop_settings"("shopId");

-- CreateIndex
CREATE INDEX "form_configs_shopId_isActive_idx" ON "form_configs"("shopId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "form_configs_shopId_name_key" ON "form_configs"("shopId", "name");

-- CreateIndex
CREATE INDEX "form_fields_formConfigId_position_idx" ON "form_fields"("formConfigId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_formConfigId_key_key" ON "form_fields"("formConfigId", "key");

-- CreateIndex
CREATE INDEX "button_configs_shopId_isEnabled_idx" ON "button_configs"("shopId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "button_configs_shopId_placement_key" ON "button_configs"("shopId", "placement");

-- CreateIndex
CREATE UNIQUE INDEX "cod_orders_reference_key" ON "cod_orders"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "cod_orders_shopifyOrderGid_key" ON "cod_orders"("shopifyOrderGid");

-- CreateIndex
CREATE UNIQUE INDEX "cod_orders_shopifyDraftOrderGid_key" ON "cod_orders"("shopifyDraftOrderGid");

-- CreateIndex
CREATE INDEX "cod_orders_shopId_status_idx" ON "cod_orders"("shopId", "status");

-- CreateIndex
CREATE INDEX "cod_orders_shopId_createdAt_idx" ON "cod_orders"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "cod_orders_shopId_riskLevel_idx" ON "cod_orders"("shopId", "riskLevel");

-- CreateIndex
CREATE INDEX "cod_orders_shopId_sheetSyncStatus_idx" ON "cod_orders"("shopId", "sheetSyncStatus");

-- CreateIndex
CREATE INDEX "cod_orders_shopId_phoneE164_idx" ON "cod_orders"("shopId", "phoneE164");

-- CreateIndex
CREATE INDEX "cod_orders_shopId_isArchived_idx" ON "cod_orders"("shopId", "isArchived");

-- CreateIndex
CREATE INDEX "cod_orders_phoneE164_idx" ON "cod_orders"("phoneE164");

-- CreateIndex
CREATE INDEX "cod_orders_email_idx" ON "cod_orders"("email");

-- CreateIndex
CREATE INDEX "cod_orders_ipAddress_idx" ON "cod_orders"("ipAddress");

-- CreateIndex
CREATE INDEX "cod_orders_addressHash_idx" ON "cod_orders"("addressHash");

-- CreateIndex
CREATE INDEX "cod_order_events_codOrderId_createdAt_idx" ON "cod_order_events"("codOrderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_shopId_key" ON "google_accounts"("shopId");

-- CreateIndex
CREATE INDEX "google_accounts_shopId_isActive_idx" ON "google_accounts"("shopId", "isActive");

-- CreateIndex
CREATE INDEX "sheet_configs_shopId_isActive_idx" ON "sheet_configs"("shopId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "sheet_configs_shopId_spreadsheetId_worksheetName_key" ON "sheet_configs"("shopId", "spreadsheetId", "worksheetName");

-- CreateIndex
CREATE INDEX "sheet_sync_logs_shopId_status_idx" ON "sheet_sync_logs"("shopId", "status");

-- CreateIndex
CREATE INDEX "sheet_sync_logs_shopId_createdAt_idx" ON "sheet_sync_logs"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "sheet_sync_logs_sheetConfigId_status_idx" ON "sheet_sync_logs"("sheetConfigId", "status");

-- CreateIndex
CREATE INDEX "sheet_sync_logs_codOrderId_idx" ON "sheet_sync_logs"("codOrderId");

-- CreateIndex
CREATE INDEX "pixels_shopId_isEnabled_idx" ON "pixels"("shopId", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "pixels_shopId_provider_pixelId_key" ON "pixels"("shopId", "provider", "pixelId");

-- CreateIndex
CREATE INDEX "pixel_events_shopId_eventName_createdAt_idx" ON "pixel_events"("shopId", "eventName", "createdAt");

-- CreateIndex
CREATE INDEX "pixel_events_shopId_status_idx" ON "pixel_events"("shopId", "status");

-- CreateIndex
CREATE INDEX "pixel_events_eventId_idx" ON "pixel_events"("eventId");

-- CreateIndex
CREATE INDEX "pixel_events_pixelId_createdAt_idx" ON "pixel_events"("pixelId", "createdAt");

-- CreateIndex
CREATE INDEX "pixel_events_codOrderId_idx" ON "pixel_events"("codOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "fraud_settings_shopId_key" ON "fraud_settings"("shopId");

-- CreateIndex
CREATE INDEX "fraud_rules_shopId_isEnabled_priority_idx" ON "fraud_rules"("shopId", "isEnabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "fraud_rules_shopId_name_key" ON "fraud_rules"("shopId", "name");

-- CreateIndex
CREATE INDEX "risk_assessments_shopId_level_idx" ON "risk_assessments"("shopId", "level");

-- CreateIndex
CREATE INDEX "risk_assessments_shopId_createdAt_idx" ON "risk_assessments"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "risk_assessments_codOrderId_createdAt_idx" ON "risk_assessments"("codOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "block_list_entries_shopId_scope_isActive_idx" ON "block_list_entries"("shopId", "scope", "isActive");

-- CreateIndex
CREATE INDEX "block_list_entries_value_idx" ON "block_list_entries"("value");

-- CreateIndex
CREATE UNIQUE INDEX "block_list_entries_shopId_type_scope_value_key" ON "block_list_entries"("shopId", "type", "scope", "value");

-- CreateIndex
CREATE UNIQUE INDEX "otp_settings_shopId_key" ON "otp_settings"("shopId");

-- CreateIndex
CREATE INDEX "otp_verifications_shopId_status_idx" ON "otp_verifications"("shopId", "status");

-- CreateIndex
CREATE INDEX "otp_verifications_destination_createdAt_idx" ON "otp_verifications"("destination", "createdAt");

-- CreateIndex
CREATE INDEX "otp_verifications_codOrderId_idx" ON "otp_verifications"("codOrderId");

-- CreateIndex
CREATE INDEX "otp_verifications_expiresAt_idx" ON "otp_verifications"("expiresAt");

-- CreateIndex
CREATE INDEX "automations_shopId_trigger_isEnabled_idx" ON "automations"("shopId", "trigger", "isEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "automations_shopId_name_key" ON "automations"("shopId", "name");

-- CreateIndex
CREATE INDEX "automation_runs_shopId_createdAt_idx" ON "automation_runs"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_automationId_status_idx" ON "automation_runs"("automationId", "status");

-- CreateIndex
CREATE INDEX "automation_runs_codOrderId_idx" ON "automation_runs"("codOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_shopId_key_channel_key" ON "notification_templates"("shopId", "key", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_shopId_key" ON "subscriptions"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_shopifySubscriptionGid_key" ON "subscriptions"("shopifySubscriptionGid");

-- CreateIndex
CREATE INDEX "subscriptions_plan_status_idx" ON "subscriptions"("plan", "status");

-- CreateIndex
CREATE INDEX "usage_records_shopId_metric_idx" ON "usage_records"("shopId", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "usage_records_shopId_periodStart_metric_key" ON "usage_records"("shopId", "periodStart", "metric");

-- CreateIndex
CREATE INDEX "daily_stats_shopId_date_idx" ON "daily_stats"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_stats_shopId_date_key" ON "daily_stats"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_shopifyWebhookId_key" ON "webhook_events"("shopifyWebhookId");

-- CreateIndex
CREATE INDEX "webhook_events_shopDomain_topic_idx" ON "webhook_events"("shopDomain", "topic");

-- CreateIndex
CREATE INDEX "webhook_events_status_createdAt_idx" ON "webhook_events"("status", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_events_shopId_topic_idx" ON "webhook_events"("shopId", "topic");

-- CreateIndex
CREATE INDEX "audit_logs_shopId_createdAt_idx" ON "audit_logs"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_shopId_action_idx" ON "audit_logs"("shopId", "action");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "shop_settings" ADD CONSTRAINT "shop_settings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_configs" ADD CONSTRAINT "form_configs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_formConfigId_fkey" FOREIGN KEY ("formConfigId") REFERENCES "form_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "button_configs" ADD CONSTRAINT "button_configs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_orders" ADD CONSTRAINT "cod_orders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_order_events" ADD CONSTRAINT "cod_order_events_codOrderId_fkey" FOREIGN KEY ("codOrderId") REFERENCES "cod_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_configs" ADD CONSTRAINT "sheet_configs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_configs" ADD CONSTRAINT "sheet_configs_googleAccountId_fkey" FOREIGN KEY ("googleAccountId") REFERENCES "google_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_sync_logs" ADD CONSTRAINT "sheet_sync_logs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_sync_logs" ADD CONSTRAINT "sheet_sync_logs_sheetConfigId_fkey" FOREIGN KEY ("sheetConfigId") REFERENCES "sheet_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sheet_sync_logs" ADD CONSTRAINT "sheet_sync_logs_codOrderId_fkey" FOREIGN KEY ("codOrderId") REFERENCES "cod_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pixels" ADD CONSTRAINT "pixels_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pixel_events" ADD CONSTRAINT "pixel_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pixel_events" ADD CONSTRAINT "pixel_events_pixelId_fkey" FOREIGN KEY ("pixelId") REFERENCES "pixels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pixel_events" ADD CONSTRAINT "pixel_events_codOrderId_fkey" FOREIGN KEY ("codOrderId") REFERENCES "cod_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_settings" ADD CONSTRAINT "fraud_settings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_rules" ADD CONSTRAINT "fraud_rules_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_codOrderId_fkey" FOREIGN KEY ("codOrderId") REFERENCES "cod_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "block_list_entries" ADD CONSTRAINT "block_list_entries_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_settings" ADD CONSTRAINT "otp_settings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_verifications" ADD CONSTRAINT "otp_verifications_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_verifications" ADD CONSTRAINT "otp_verifications_codOrderId_fkey" FOREIGN KEY ("codOrderId") REFERENCES "cod_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_codOrderId_fkey" FOREIGN KEY ("codOrderId") REFERENCES "cod_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;


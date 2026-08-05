/**
 * Development seed.
 *
 * Provisions one fully-configured shop so the admin UI, form renderer and
 * fraud engine all have something to read during local development and
 * integration tests.
 *
 * The default records come from `src/modules/shop/defaults.ts` — the same
 * module the install-time provisioning service reads — so a developer's local
 * database and a real merchant's first install cannot drift apart.
 *
 * Deliberately does *not* import the provisioning service itself: that reaches
 * `src/db/prisma`, which reaches `src/config/env`, which refuses to load
 * without a complete Shopify environment. Requiring production-shaped secrets
 * in order to seed a local database is a footgun, so the seed keeps its own
 * client and repeats the upsert loop.
 *
 * Idempotent — every write is an upsert keyed on a natural unique constraint,
 * so re-running will not duplicate rows.
 *
 * It does still need DATABASE_URL, which is why it loads the root `.env`
 * itself — `tsx prisma/seed.ts` runs with the cwd set to `apps/api`, so the
 * plain `dotenv/config` import would look one directory too deep.
 */

import { OtpProvider, Plan, PrismaClient, SubscriptionStatus } from '@prisma/client';
import { loadRootEnv } from '../src/lib/loadDotenv';
import {
  DEFAULT_BUTTON_CONFIGS,
  DEFAULT_FORM_CONFIG,
  DEFAULT_FORM_FIELDS,
  DEFAULT_NOTIFICATION_TEMPLATES,
  FIELD_POSITION_STEP,
} from '../src/modules/shop/defaults';

// Before the client is constructed: it reads DATABASE_URL at construction time,
// and a client built without one fails later with a schema validation error that
// points at the schema rather than at the missing variable.
loadRootEnv();

const prisma = new PrismaClient();

const SHOP_DOMAIN = process.env.SEED_SHOP_DOMAIN ?? 'codflow-dev.myshopify.com';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. Set ALLOW_PROD_SEED=true to override.',
    );
  }

  console.log(`Seeding shop ${SHOP_DOMAIN}…`);

  const shop = await prisma.shop.upsert({
    where: { domain: SHOP_DOMAIN },
    update: {},
    create: {
      domain: SHOP_DOMAIN,
      name: 'CodFlow Dev Store',
      email: 'dev@codflow.test',
      ownerName: 'Dev Merchant',
      countryCode: 'IN',
      currencyCode: 'INR',
      primaryLocale: 'en',
      timezone: 'Asia/Kolkata',
      ianaTimezone: 'Asia/Kolkata',
      shopifyPlan: 'partner_test',
      isActive: true,
    },
  });

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    update: {},
    create: {
      shopId: shop.id,
      codEnabled: true,
      replaceBuyNow: true,
      notifyEmail: 'dev@codflow.test',
      // Realistic INR economics so the dev dashboard shows sensible numbers.
      codFeeEnabled: true,
      codFeeAmount: 49,
      minOrderValue: 199,
      maxOrderValue: 25000,
      shippingFee: 60,
      freeShippingAbove: 999,
    },
  });

  await prisma.subscription.upsert({
    where: { shopId: shop.id },
    update: {},
    create: {
      shopId: shop.id,
      plan: Plan.FREE,
      status: SubscriptionStatus.ACTIVE,
      currencyCode: 'INR',
      activatedAt: new Date(),
      lastVerifiedAt: new Date(),
    },
  });

  await prisma.fraudSettings.upsert({
    where: { shopId: shop.id },
    update: {},
    create: { shopId: shop.id, isEnabled: true },
  });

  await prisma.otpSettings.upsert({
    where: { shopId: shop.id },
    update: {},
    create: { shopId: shop.id, isEnabled: false, provider: OtpProvider.MSG91 },
  });

  // ---- Form: upsert the config, then its fields keyed on (formConfigId, key).
  const formConfig = await prisma.formConfig.upsert({
    where: { shopId_name: { shopId: shop.id, name: DEFAULT_FORM_CONFIG.name } },
    update: {},
    create: { shopId: shop.id, ...DEFAULT_FORM_CONFIG },
  });

  for (const [index, field] of DEFAULT_FORM_FIELDS.entries()) {
    await prisma.formField.upsert({
      where: { formConfigId_key: { formConfigId: formConfig.id, key: field.key } },
      update: {},
      create: { formConfigId: formConfig.id, ...field, position: index * FIELD_POSITION_STEP },
    });
  }

  for (const button of DEFAULT_BUTTON_CONFIGS) {
    await prisma.buttonConfig.upsert({
      where: { shopId_placement: { shopId: shop.id, placement: button.placement } },
      update: {},
      create: { shopId: shop.id, ...button },
    });
  }

  for (const template of DEFAULT_NOTIFICATION_TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: {
        shopId_key_channel: { shopId: shop.id, key: template.key, channel: template.channel },
      },
      update: {},
      create: { shopId: shop.id, ...template },
    });
  }

  console.log(
    `Seed complete — shop ${shop.domain} (${shop.id}): ` +
      `${DEFAULT_FORM_FIELDS.length} form fields, ` +
      `${DEFAULT_BUTTON_CONFIGS.length} button configs, ` +
      `${DEFAULT_NOTIFICATION_TEMPLATES.length} notification templates.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });

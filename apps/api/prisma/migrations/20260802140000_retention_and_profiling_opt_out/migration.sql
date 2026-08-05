-- AlterTable
ALTER TABLE "cod_orders" ADD COLUMN     "profilingOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "redactedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "shop_settings" ADD COLUMN     "orderRetentionDays" INTEGER NOT NULL DEFAULT 365;

-- CreateIndex
CREATE INDEX "cod_orders_shopId_redactedAt_createdAt_idx" ON "cod_orders"("shopId", "redactedAt", "createdAt");

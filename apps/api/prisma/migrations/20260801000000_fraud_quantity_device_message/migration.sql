-- AlterTable
ALTER TABLE "fraud_settings" ADD COLUMN     "blockedMessage" TEXT,
ADD COLUMN     "checkDeviceVelocity" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxItemsPerOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maxOrdersPerDayPerDevice" INTEGER NOT NULL DEFAULT 3;


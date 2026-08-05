-- AlterTable
ALTER TABLE "shop_settings" ADD COLUMN     "brandLogoAlignment" TEXT NOT NULL DEFAULT 'left',
ADD COLUMN     "brandLogoHeight" INTEGER NOT NULL DEFAULT 40;

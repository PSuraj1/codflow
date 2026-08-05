-- AlterTable
ALTER TABLE "cod_orders" ADD COLUMN     "bumpTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "selectedBumps" JSONB NOT NULL DEFAULT '[]';
-- CreateTable
CREATE TABLE "order_bumps" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "defaultChecked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_bumps_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "order_bumps_shopId_isEnabled_position_idx" ON "order_bumps"("shopId", "isEnabled", "position");
-- AddForeignKey
ALTER TABLE "order_bumps" ADD CONSTRAINT "order_bumps_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

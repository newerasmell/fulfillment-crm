-- Phase 1 (Shopify import): additive columns only; safe on populated tables.
BEGIN;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "shopifyFinancialStatus" TEXT,
ADD COLUMN     "shopifyFulfillmentStatus" TEXT,
ADD COLUMN     "shopifyUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "shopifyLineGid" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "codGateways" TEXT[] DEFAULT ARRAY['Cash on Delivery (COD)', 'cash_on_delivery', 'Наложен платеж']::TEXT[],
ADD COLUMN     "connectionStatus" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "shopName" TEXT,
ADD COLUMN     "skuPrefix" TEXT;

-- AlterTable
ALTER TABLE "StoreVariantLink" ADD COLUMN     "barcode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_orderId_shopifyLineGid_key" ON "OrderLine"("orderId", "shopifyLineGid");


COMMIT;

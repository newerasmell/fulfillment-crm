-- Rules & weights fix (2026-11-03): per-country phone rules use the existing CountrySetting.phoneRules column;
-- product weights get their source/author, store variants the weight Shopify reports, stores a "Тегло към Shopify"
-- mode (DISABLED by default) and one new table for the weight write-back. Additive only: nullable columns, a column
-- with a default, one new table with row-level security like every tenant table.
BEGIN;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "weightSetAt" TIMESTAMP(3),
ADD COLUMN     "weightSetById" TEXT,
ADD COLUMN     "weightSource" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "weightWriteMode" "InventoryPushMode" NOT NULL DEFAULT 'DISABLED';

-- AlterTable
ALTER TABLE "StoreVariantLink" ADD COLUMN     "shopifyWeightGrams" INTEGER;

-- CreateTable
CREATE TABLE "ShopifyWeightWrite" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantLinkId" TEXT NOT NULL,
    "weightGrams" INTEGER NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "evaluatedMode" "InventoryPushMode",
    "request" JSONB,
    "lastResponse" JSONB,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyWeightWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyWeightWrite_accountId_productId_createdAt_idx" ON "ShopifyWeightWrite"("accountId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyWeightWrite_status_nextAttemptAt_idx" ON "ShopifyWeightWrite"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWeightWrite_accountId_id_key" ON "ShopifyWeightWrite"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWeightWrite_variantLinkId_weightGrams_key" ON "ShopifyWeightWrite"("variantLinkId", "weightGrams");

-- AddForeignKey
ALTER TABLE "ShopifyWeightWrite" ADD CONSTRAINT "ShopifyWeightWrite_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWeightWrite" ADD CONSTRAINT "ShopifyWeightWrite_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWeightWrite" ADD CONSTRAINT "ShopifyWeightWrite_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWeightWrite" ADD CONSTRAINT "ShopifyWeightWrite_accountId_variantLinkId_fkey" FOREIGN KEY ("accountId", "variantLinkId") REFERENCES "StoreVariantLink"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyWeightWrite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyWeightWrite" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShopifyWeightWrite" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

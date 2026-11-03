-- Wave 3 stock track (P5-01..P5-03): stock settings, Shopify locations + inventory mirror, inventory push outbox.
-- Additive only: five NEW tables (no column added to an existing table), so it is safe on a populated database.
BEGIN;

-- CreateTable
CREATE TABLE "StockSettings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shopifyThreshold" INTEGER NOT NULL DEFAULT 2,
    "fhbStaleHours" INTEGER NOT NULL DEFAULT 2,
    "euStaleHours" INTEGER NOT NULL DEFAULT 30,
    "runOutDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreLocation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyLocationGid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "fulfillmentService" TEXT,
    "connectionId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyInventoryLevel" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "variantLinkId" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "inventoryItemGid" TEXT NOT NULL,
    "tracked" BOOLEAN NOT NULL DEFAULT true,
    "available" INTEGER NOT NULL,
    "onHand" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyInventoryLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPush" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "evaluatedMode" "InventoryPushMode",
    "buffer" INTEGER NOT NULL,
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

    CONSTRAINT "InventoryPush_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPushLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "pushId" TEXT NOT NULL,
    "variantLinkId" TEXT NOT NULL,
    "productId" TEXT,
    "connectionId" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "inventoryItemGid" TEXT NOT NULL,
    "sellable" INTEGER NOT NULL,
    "target" INTEGER NOT NULL,
    "shopifyBefore" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "error" TEXT,

    CONSTRAINT "InventoryPushLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockSettings_accountId_key" ON "StockSettings"("accountId");

-- CreateIndex
CREATE INDEX "StoreLocation_accountId_idx" ON "StoreLocation"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLocation_accountId_id_key" ON "StoreLocation"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLocation_storeId_shopifyLocationGid_key" ON "StoreLocation"("storeId", "shopifyLocationGid");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLocation_storeId_connectionId_key" ON "StoreLocation"("storeId", "connectionId");

-- CreateIndex
CREATE INDEX "ShopifyInventoryLevel_accountId_storeId_idx" ON "ShopifyInventoryLevel"("accountId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyInventoryLevel_accountId_id_key" ON "ShopifyInventoryLevel"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyInventoryLevel_variantLinkId_locationGid_key" ON "ShopifyInventoryLevel"("variantLinkId", "locationGid");

-- CreateIndex
CREATE INDEX "InventoryPush_accountId_storeId_createdAt_idx" ON "InventoryPush"("accountId", "storeId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryPush_status_nextAttemptAt_idx" ON "InventoryPush"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPush_accountId_id_key" ON "InventoryPush"("accountId", "id");

-- CreateIndex
CREATE INDEX "InventoryPushLine_accountId_pushId_idx" ON "InventoryPushLine"("accountId", "pushId");

-- AddForeignKey
ALTER TABLE "StockSettings" ADD CONSTRAINT "StockSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLocation" ADD CONSTRAINT "StoreLocation_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyInventoryLevel" ADD CONSTRAINT "ShopifyInventoryLevel_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyInventoryLevel" ADD CONSTRAINT "ShopifyInventoryLevel_accountId_variantLinkId_fkey" FOREIGN KEY ("accountId", "variantLinkId") REFERENCES "StoreVariantLink"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPush" ADD CONSTRAINT "InventoryPush_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPush" ADD CONSTRAINT "InventoryPush_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPushLine" ADD CONSTRAINT "InventoryPushLine_accountId_pushId_fkey" FOREIGN KEY ("accountId", "pushId") REFERENCES "InventoryPush"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "StockSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StockSettings" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "StoreLocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreLocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StoreLocation" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ShopifyInventoryLevel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyInventoryLevel" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShopifyInventoryLevel" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "InventoryPush" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryPush" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InventoryPush" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "InventoryPushLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryPushLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InventoryPushLine" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

-- Wave 2 fulfill track (P4-07): Shopify fulfillment write-back per shipment. New table only; nothing changes on existing rows.
BEGIN;
-- CreateTable
CREATE TABLE "ShopifyWriteBack" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "evaluatedMode" "StoreWriteMode",
    "trackingNumber" TEXT NOT NULL,
    "request" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastResponse" JSONB,
    "lastError" TEXT,
    "shopifyFulfillmentGid" TEXT,
    "lockedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyWriteBack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyWriteBack_accountId_orderId_idx" ON "ShopifyWriteBack"("accountId", "orderId");

-- CreateIndex
CREATE INDEX "ShopifyWriteBack_status_nextAttemptAt_idx" ON "ShopifyWriteBack"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWriteBack_accountId_id_key" ON "ShopifyWriteBack"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWriteBack_accountId_fulfillmentId_key" ON "ShopifyWriteBack"("accountId", "fulfillmentId");

-- AddForeignKey
ALTER TABLE "ShopifyWriteBack" ADD CONSTRAINT "ShopifyWriteBack_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWriteBack" ADD CONSTRAINT "ShopifyWriteBack_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWriteBack" ADD CONSTRAINT "ShopifyWriteBack_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWriteBack" ADD CONSTRAINT "ShopifyWriteBack_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "ShopifyWriteBack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyWriteBack" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShopifyWriteBack" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

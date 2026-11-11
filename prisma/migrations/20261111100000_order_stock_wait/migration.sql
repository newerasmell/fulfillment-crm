-- "Липсващи артикули" (owner request 2026-11-10). Additive only: two new tables, no column of an existing table
-- changes, so it applies cleanly on a database that already holds data.

-- CreateTable
CREATE TABLE "OrderStockWait" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OUT_OF_STOCK',
    "missingLineIds" TEXT[],
    "expected" BOOLEAN NOT NULL DEFAULT false,
    "readyConnectionId" TEXT,
    "detail" JSONB,
    "notifiedState" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderStockWait_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyTagWrite" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "add" TEXT[],
    "remove" TEXT[],
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "evaluatedMode" "StoreWriteMode",
    "request" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyTagWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStockWait_accountId_state_idx" ON "OrderStockWait"("accountId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "OrderStockWait_accountId_id_key" ON "OrderStockWait"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderStockWait_accountId_orderId_key" ON "OrderStockWait"("accountId", "orderId");

-- CreateIndex
CREATE INDEX "ShopifyTagWrite_accountId_orderId_idx" ON "ShopifyTagWrite"("accountId", "orderId");

-- CreateIndex
CREATE INDEX "ShopifyTagWrite_status_nextAttemptAt_idx" ON "ShopifyTagWrite"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyTagWrite_accountId_id_key" ON "ShopifyTagWrite"("accountId", "id");

-- AddForeignKey
ALTER TABLE "OrderStockWait" ADD CONSTRAINT "OrderStockWait_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStockWait" ADD CONSTRAINT "OrderStockWait_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyTagWrite" ADD CONSTRAINT "ShopifyTagWrite_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyTagWrite" ADD CONSTRAINT "ShopifyTagWrite_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyTagWrite" ADD CONSTRAINT "ShopifyTagWrite_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "OrderStockWait" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderStockWait" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderStockWait" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "ShopifyTagWrite" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyTagWrite" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShopifyTagWrite" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

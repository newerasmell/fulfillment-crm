-- Противосаботаж + fast stock sync (owner request 2026-11-10). Additive only: a new enum value (no existing row
-- uses it), two new tables and one plain index; no column of an existing table changes, so it applies cleanly
-- on a database that already holds data.
ALTER TYPE "CrmOrderStatus" ADD VALUE IF NOT EXISTS 'QTY_HOLD';

CREATE TABLE "LineStockGuard" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxPerProduct" INTEGER,
    "maxPerOrder" INTEGER,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LineStockGuard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LineStockGuard_accountId_id_key" ON "LineStockGuard"("accountId", "id");
CREATE UNIQUE INDEX "LineStockGuard_accountId_lineId_key" ON "LineStockGuard"("accountId", "lineId");

ALTER TABLE "LineStockGuard" ADD CONSTRAINT "LineStockGuard_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LineStockGuard" ADD CONSTRAINT "LineStockGuard_accountId_lineId_fkey" FOREIGN KEY ("accountId", "lineId") REFERENCES "ProductLine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LineStockGuard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LineStockGuard" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "LineStockGuard" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

CREATE TABLE "StockSyncCursor" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockSyncCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockSyncCursor_accountId_key" ON "StockSyncCursor"("accountId");
CREATE UNIQUE INDEX "StockSyncCursor_accountId_id_key" ON "StockSyncCursor"("accountId", "id");

ALTER TABLE "StockSyncCursor" ADD CONSTRAINT "StockSyncCursor_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockSyncCursor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockSyncCursor" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StockSyncCursor" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

CREATE INDEX "Order_accountId_updatedAt_idx" ON "Order"("accountId", "updatedAt");

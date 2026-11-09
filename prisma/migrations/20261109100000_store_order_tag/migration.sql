-- "Само поръчки с таг" (owner request 2026-11-09). Additive only: a new enum value (no existing row uses it) and a
-- new table; nothing existing is altered, so it applies cleanly on a database that already holds data.
ALTER TYPE "CrmOrderStatus" ADD VALUE IF NOT EXISTS 'AWAITING_TAG';

CREATE TABLE "StoreOrderTag" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreOrderTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreOrderTag_accountId_id_key" ON "StoreOrderTag"("accountId", "id");
CREATE UNIQUE INDEX "StoreOrderTag_accountId_storeId_key" ON "StoreOrderTag"("accountId", "storeId");

ALTER TABLE "StoreOrderTag" ADD CONSTRAINT "StoreOrderTag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreOrderTag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoreOrderTag" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "StoreOrderTag" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "StoreOrderTag" ADD CONSTRAINT "StoreOrderTag_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

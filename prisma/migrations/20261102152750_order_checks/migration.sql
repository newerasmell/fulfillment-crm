-- Phase 4 core (wave 2): latest pre-flight check per order. New table only; nothing changes on existing rows.
BEGIN;
-- CreateTable
CREATE TABLE "OrderCheck" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT,
    "ruleId" TEXT,
    "routing" JSONB NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "hardCount" INTEGER NOT NULL DEFAULT 0,
    "softCount" INTEGER NOT NULL DEFAULT 0,
    "normalised" JSONB NOT NULL DEFAULT '{}',
    "checkedById" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderCheck_accountId_checkedAt_idx" ON "OrderCheck"("accountId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCheck_accountId_orderId_key" ON "OrderCheck"("accountId", "orderId");

-- AddForeignKey
ALTER TABLE "OrderCheck" ADD CONSTRAINT "OrderCheck_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "OrderCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderCheck" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderCheck" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

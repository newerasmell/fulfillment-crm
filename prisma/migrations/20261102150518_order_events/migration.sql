-- Phase 4 core (wave 2): order pipeline events. New table only; nothing changes on existing rows.
BEGIN;
-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" "CrmOrderStatus",
    "toStatus" "CrmOrderStatus" NOT NULL,
    "cause" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "userId" TEXT,
    "source" TEXT,
    "reason" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderEvent_accountId_orderId_createdAt_idx" ON "OrderEvent"("accountId", "orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "OrderEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderEvent" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

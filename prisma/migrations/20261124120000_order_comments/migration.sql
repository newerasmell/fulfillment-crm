-- Comments on an order (owner request 2026-11-24). Additive only: one new table, no column of an existing table
-- changes, so it applies cleanly on a database that already holds data.

-- CreateTable
CREATE TABLE "OrderComment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderComment_accountId_orderId_createdAt_idx" ON "OrderComment"("accountId", "orderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderComment_accountId_id_key" ON "OrderComment"("accountId", "id");

-- AddForeignKey
ALTER TABLE "OrderComment" ADD CONSTRAINT "OrderComment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderComment" ADD CONSTRAINT "OrderComment_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (as every table with accountId).
ALTER TABLE "OrderComment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderComment" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderComment" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

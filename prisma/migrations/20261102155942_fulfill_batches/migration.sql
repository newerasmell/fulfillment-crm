-- Wave 2 fulfill track (P4-06): Fulfill batches and their per-order results. New tables only; nothing changes on existing rows.
BEGIN;
-- CreateTable
CREATE TABLE "FulfillBatch" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FulfillBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillBatchItem" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "code" TEXT,
    "findings" JSONB,
    "connectionId" TEXT,
    "liveMode" "LiveMode",
    "requestId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FulfillBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FulfillBatch_accountId_createdAt_idx" ON "FulfillBatch"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillBatch_accountId_id_key" ON "FulfillBatch"("accountId", "id");

-- CreateIndex
CREATE INDEX "FulfillBatchItem_accountId_orderId_idx" ON "FulfillBatchItem"("accountId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillBatchItem_accountId_id_key" ON "FulfillBatchItem"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillBatchItem_batchId_orderId_key" ON "FulfillBatchItem"("batchId", "orderId");

-- AddForeignKey
ALTER TABLE "FulfillBatch" ADD CONSTRAINT "FulfillBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillBatchItem" ADD CONSTRAINT "FulfillBatchItem_accountId_batchId_fkey" FOREIGN KEY ("accountId", "batchId") REFERENCES "FulfillBatch"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillBatchItem" ADD CONSTRAINT "FulfillBatchItem_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "FulfillBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FulfillBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FulfillBatch" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FulfillBatchItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FulfillBatchItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FulfillBatchItem" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

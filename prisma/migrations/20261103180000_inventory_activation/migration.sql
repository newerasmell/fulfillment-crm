-- Owner request 2026-11-03: "Активирай продуктите в тази локация" (inventoryActivate through its own outbox).
-- Additive only: two NEW tables (no existing table is altered), with the same row-level security as every
-- account table. Safe on a populated database.
-- CreateTable
CREATE TABLE "InventoryActivation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "evaluatedMode" "InventoryPushMode",
    "request" JSONB,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryActivationLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "activationId" TEXT NOT NULL,
    "variantLinkId" TEXT NOT NULL,
    "inventoryItemGid" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "attempted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "error" TEXT,

    CONSTRAINT "InventoryActivationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryActivation_accountId_storeId_locationGid_createdAt_idx" ON "InventoryActivation"("accountId", "storeId", "locationGid", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryActivation_status_nextAttemptAt_idx" ON "InventoryActivation"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryActivation_accountId_id_key" ON "InventoryActivation"("accountId", "id");

-- CreateIndex
CREATE INDEX "InventoryActivationLine_accountId_activationId_idx" ON "InventoryActivationLine"("accountId", "activationId");

-- AddForeignKey
ALTER TABLE "InventoryActivation" ADD CONSTRAINT "InventoryActivation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryActivation" ADD CONSTRAINT "InventoryActivation_accountId_storeId_fkey" FOREIGN KEY ("accountId", "storeId") REFERENCES "Store"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryActivationLine" ADD CONSTRAINT "InventoryActivationLine_accountId_activationId_fkey" FOREIGN KEY ("accountId", "activationId") REFERENCES "InventoryActivation"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (same policy as InventoryPush / InventoryPushLine)
ALTER TABLE "InventoryActivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryActivation" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InventoryActivation" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "InventoryActivationLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InventoryActivationLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InventoryActivationLine" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

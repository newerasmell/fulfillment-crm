-- Phase 3 (euShipments core): new tables only; nothing changes on existing rows.
BEGIN;
-- CreateEnum
CREATE TYPE "EushipmentsStatusCategory" AS ENUM ('ACCEPTED', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'RETURNING', 'RETURN_RECEIVED', 'CANCELLED', 'CANCEL_PENDING', 'BLOCKED', 'EXCEPTION', 'UNKNOWN');

-- CreateTable
CREATE TABLE "EushipmentsStatusMapping" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "statusKey" TEXT NOT NULL,
    "statusText" TEXT NOT NULL,
    "vendorStatusId" INTEGER,
    "category" "EushipmentsStatusCategory" NOT NULL,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsStatusMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsSettings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "acceptedAlertHours" INTEGER NOT NULL DEFAULT 24,
    "acceptedAlertWorkDays" BOOLEAN NOT NULL DEFAULT true,
    "cashReceiptCod" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsTransfer" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "sourceWarehouseId" INTEGER NOT NULL,
    "destinationWarehouseId" INTEGER,
    "protocolType" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL,
    "comments" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "protocolId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsStatusMapping_accountId_id_key" ON "EushipmentsStatusMapping"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsStatusMapping_accountId_statusKey_key" ON "EushipmentsStatusMapping"("accountId", "statusKey");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsSettings_accountId_id_key" ON "EushipmentsSettings"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsSettings_accountId_connectionId_key" ON "EushipmentsSettings"("accountId", "connectionId");

-- CreateIndex
CREATE INDEX "EushipmentsTransfer_accountId_idx" ON "EushipmentsTransfer"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsTransfer_accountId_id_key" ON "EushipmentsTransfer"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsTransfer_connectionId_externalRef_key" ON "EushipmentsTransfer"("connectionId", "externalRef");

-- AddForeignKey
ALTER TABLE "EushipmentsStatusMapping" ADD CONSTRAINT "EushipmentsStatusMapping_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsSettings" ADD CONSTRAINT "EushipmentsSettings_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsTransfer" ADD CONSTRAINT "EushipmentsTransfer_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "EushipmentsStatusMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsStatusMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsStatusMapping" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsSettings" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsTransfer" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

-- Wave 1 · FHB v3 read mirror (P2-02): new tables only, nothing existing is altered; safe on populated databases.
BEGIN;

-- CreateTable
CREATE TABLE "FhbSyncState" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbOrderMirror" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "uid" TEXT,
    "variableSymbol" TEXT,
    "rawStatus" TEXT,
    "status" "CrmOrderStatus" NOT NULL,
    "parcelService" TEXT,
    "deliveryPoint" TEXT,
    "cod" DECIMAL(12,2),
    "value" DECIMAL(12,2),
    "country" TEXT,
    "recipientName" TEXT,
    "trackingNumbers" TEXT[],
    "vendorCreatedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "returnType" TEXT,
    "inRma" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB NOT NULL,
    "lastSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbOrderMirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbCodMirror" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "uid" TEXT,
    "variableSymbol" TEXT,
    "parcelService" TEXT,
    "cod" DECIMAL(12,2),
    "status" TEXT,
    "receivedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "vendorCreatedAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "lastSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbCodMirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbReturnMirror" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "vendorId" TEXT,
    "depotId" TEXT,
    "type" TEXT,
    "status" TEXT,
    "weight" DOUBLE PRECISION,
    "barcodes" TEXT[],
    "items" JSONB NOT NULL DEFAULT '[]',
    "photos" JSONB NOT NULL DEFAULT '[]',
    "vendorCreatedAt" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "lastSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbReturnMirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbCarrier" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "lastSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbCarrier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbPickupPoint" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "queryCountry" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "externalCode" TEXT,
    "name" TEXT,
    "street" TEXT,
    "city" TEXT,
    "zip" TEXT,
    "country" TEXT,
    "lastSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbPickupPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FhbSyncState_accountId_idx" ON "FhbSyncState"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FhbSyncState_accountId_id_key" ON "FhbSyncState"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbSyncState_connectionId_resource_key" ON "FhbSyncState"("connectionId", "resource");

-- CreateIndex
CREATE INDEX "FhbOrderMirror_accountId_connectionId_vendorCreatedAt_idx" ON "FhbOrderMirror"("accountId", "connectionId", "vendorCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FhbOrderMirror_accountId_id_key" ON "FhbOrderMirror"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbOrderMirror_connectionId_externalId_key" ON "FhbOrderMirror"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "FhbCodMirror_accountId_connectionId_status_idx" ON "FhbCodMirror"("accountId", "connectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FhbCodMirror_accountId_id_key" ON "FhbCodMirror"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbCodMirror_connectionId_externalId_key" ON "FhbCodMirror"("connectionId", "externalId");

-- CreateIndex
CREATE INDEX "FhbReturnMirror_accountId_connectionId_vendorCreatedAt_idx" ON "FhbReturnMirror"("accountId", "connectionId", "vendorCreatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FhbReturnMirror_accountId_id_key" ON "FhbReturnMirror"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbReturnMirror_connectionId_uid_key" ON "FhbReturnMirror"("connectionId", "uid");

-- CreateIndex
CREATE UNIQUE INDEX "FhbCarrier_accountId_id_key" ON "FhbCarrier"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbCarrier_connectionId_code_key" ON "FhbCarrier"("connectionId", "code");

-- CreateIndex
CREATE INDEX "FhbPickupPoint_accountId_connectionId_service_idx" ON "FhbPickupPoint"("accountId", "connectionId", "service");

-- CreateIndex
CREATE UNIQUE INDEX "FhbPickupPoint_accountId_id_key" ON "FhbPickupPoint"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbPickupPoint_connectionId_service_queryCountry_vendorId_key" ON "FhbPickupPoint"("connectionId", "service", "queryCountry", "vendorId");

-- AddForeignKey
ALTER TABLE "FhbSyncState" ADD CONSTRAINT "FhbSyncState_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbOrderMirror" ADD CONSTRAINT "FhbOrderMirror_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbCodMirror" ADD CONSTRAINT "FhbCodMirror_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbReturnMirror" ADD CONSTRAINT "FhbReturnMirror_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbCarrier" ADD CONSTRAINT "FhbCarrier_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbPickupPoint" ADD CONSTRAINT "FhbPickupPoint_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security (same policy as every business table, see the rls migration).
ALTER TABLE "FhbSyncState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbSyncState" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbSyncState" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbOrderMirror" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbOrderMirror" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbOrderMirror" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbCodMirror" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbCodMirror" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbCodMirror" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbReturnMirror" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbReturnMirror" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbReturnMirror" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbCarrier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbCarrier" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbCarrier" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbPickupPoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbPickupPoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbPickupPoint" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

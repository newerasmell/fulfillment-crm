-- „Блокирани в склад“ (owner request 2026-11-18): per-company warehouse email settings, cases of stuck shipments, their
-- emails, and units a warehouse could not give. Additive only: five new tables, no column of an existing table
-- changes, so it applies cleanly on a database that already holds data.


-- CreateTable
CREATE TABLE "CompanyEscalationSettings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "senderEmail" TEXT,
    "warehouseTo" TEXT[],
    "warehouseCc" TEXT[],
    "escalationTo" TEXT[],
    "flagHours" INTEGER NOT NULL DEFAULT 12,
    "firstEmailHours" INTEGER NOT NULL DEFAULT 24,
    "reminderHours" INTEGER NOT NULL DEFAULT 48,
    "decisionHours" INTEGER NOT NULL DEFAULT 72,
    "workDaysOnly" BOOLEAN NOT NULL DEFAULT true,
    "discountPercent" INTEGER,
    "customerSubject" TEXT,
    "customerBody" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyEscalationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseCase" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "openKey" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarehouseCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseCaseOrder" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "warehouseConfirmedAt" TIMESTAMP(3),
    "customerEmailedAt" TIMESTAMP(3),

    CONSTRAINT "WarehouseCaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseCaseMessage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT,
    "recipients" TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "orderNumbers" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WarehouseCaseMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuIncident" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearNote" TEXT,

    CONSTRAINT "SkuIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEscalationSettings_accountId_id_key" ON "CompanyEscalationSettings"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEscalationSettings_accountId_companyId_key" ON "CompanyEscalationSettings"("accountId", "companyId");

-- CreateIndex
CREATE INDEX "WarehouseCase_accountId_closedAt_idx" ON "WarehouseCase"("accountId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseCase_accountId_id_key" ON "WarehouseCase"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseCase_accountId_openKey_key" ON "WarehouseCase"("accountId", "openKey");

-- CreateIndex
CREATE INDEX "WarehouseCaseOrder_accountId_orderId_idx" ON "WarehouseCaseOrder"("accountId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseCaseOrder_accountId_id_key" ON "WarehouseCaseOrder"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseCaseOrder_caseId_fulfillmentId_key" ON "WarehouseCaseOrder"("caseId", "fulfillmentId");

-- CreateIndex
CREATE INDEX "WarehouseCaseMessage_accountId_caseId_createdAt_idx" ON "WarehouseCaseMessage"("accountId", "caseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WarehouseCaseMessage_accountId_id_key" ON "WarehouseCaseMessage"("accountId", "id");

-- CreateIndex
CREATE INDEX "SkuIncident_accountId_connectionId_productId_clearedAt_idx" ON "SkuIncident"("accountId", "connectionId", "productId", "clearedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkuIncident_accountId_id_key" ON "SkuIncident"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SkuIncident_fulfillmentId_productId_key" ON "SkuIncident"("fulfillmentId", "productId");

-- AddForeignKey
ALTER TABLE "CompanyEscalationSettings" ADD CONSTRAINT "CompanyEscalationSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEscalationSettings" ADD CONSTRAINT "CompanyEscalationSettings_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCase" ADD CONSTRAINT "WarehouseCase_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCase" ADD CONSTRAINT "WarehouseCase_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCase" ADD CONSTRAINT "WarehouseCase_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCaseOrder" ADD CONSTRAINT "WarehouseCaseOrder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCaseOrder" ADD CONSTRAINT "WarehouseCaseOrder_accountId_caseId_fkey" FOREIGN KEY ("accountId", "caseId") REFERENCES "WarehouseCase"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCaseOrder" ADD CONSTRAINT "WarehouseCaseOrder_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCaseOrder" ADD CONSTRAINT "WarehouseCaseOrder_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCaseMessage" ADD CONSTRAINT "WarehouseCaseMessage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseCaseMessage" ADD CONSTRAINT "WarehouseCaseMessage_accountId_caseId_fkey" FOREIGN KEY ("accountId", "caseId") REFERENCES "WarehouseCase"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuIncident" ADD CONSTRAINT "SkuIncident_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuIncident" ADD CONSTRAINT "SkuIncident_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuIncident" ADD CONSTRAINT "SkuIncident_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "CompanyEscalationSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CompanyEscalationSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "CompanyEscalationSettings" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "WarehouseCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarehouseCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "WarehouseCase" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "WarehouseCaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarehouseCaseOrder" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "WarehouseCaseOrder" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "WarehouseCaseMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WarehouseCaseMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "WarehouseCaseMessage" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "SkuIncident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SkuIncident" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "SkuIncident" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

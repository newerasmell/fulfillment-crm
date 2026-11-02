-- Wave 3 core (P5-00): product lines + master catalogue. Additive only: new tables and two NULLABLE columns
-- (Company.lineId, Product.lineId) — safe on tables that already hold rows; nothing is backfilled.
BEGIN;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "lineId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lineId" TEXT;

-- CreateTable
CREATE TABLE "ProductLine" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'indigo',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterCatalogueRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'masters',
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "linked" INTEGER NOT NULL DEFAULT 0,
    "adopted" INTEGER NOT NULL DEFAULT 0,
    "alreadyLinked" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "autoLinked" INTEGER NOT NULL DEFAULT 0,
    "conflictSamples" JSONB NOT NULL DEFAULT '[]',
    "cursor" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterCatalogueRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMatchDismissal" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMatchDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMappingImport" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "plan" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ProductMappingImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductLine_accountId_id_key" ON "ProductLine"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLine_accountId_name_key" ON "ProductLine"("accountId", "name");

-- CreateIndex
CREATE INDEX "MasterCatalogueRun_accountId_lineId_createdAt_idx" ON "MasterCatalogueRun"("accountId", "lineId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MasterCatalogueRun_accountId_id_key" ON "MasterCatalogueRun"("accountId", "id");

-- CreateIndex
CREATE INDEX "ProductMatchDismissal_accountId_lineId_idx" ON "ProductMatchDismissal"("accountId", "lineId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMatchDismissal_accountId_kind_itemId_productId_key" ON "ProductMatchDismissal"("accountId", "kind", "itemId", "productId");

-- CreateIndex
CREATE INDEX "ProductMappingImport_accountId_lineId_createdAt_idx" ON "ProductMappingImport"("accountId", "lineId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMappingImport_accountId_id_key" ON "ProductMappingImport"("accountId", "id");

-- CreateIndex
CREATE INDEX "Product_accountId_lineId_idx" ON "Product"("accountId", "lineId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_accountId_lineId_fkey" FOREIGN KEY ("accountId", "lineId") REFERENCES "ProductLine"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_accountId_lineId_fkey" FOREIGN KEY ("accountId", "lineId") REFERENCES "ProductLine"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductLine" ADD CONSTRAINT "ProductLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterCatalogueRun" ADD CONSTRAINT "MasterCatalogueRun_accountId_lineId_fkey" FOREIGN KEY ("accountId", "lineId") REFERENCES "ProductLine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterCatalogueRun" ADD CONSTRAINT "MasterCatalogueRun_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMatchDismissal" ADD CONSTRAINT "ProductMatchDismissal_accountId_lineId_fkey" FOREIGN KEY ("accountId", "lineId") REFERENCES "ProductLine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMappingImport" ADD CONSTRAINT "ProductMappingImport_accountId_lineId_fkey" FOREIGN KEY ("accountId", "lineId") REFERENCES "ProductLine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "ProductLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ProductLine" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "MasterCatalogueRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MasterCatalogueRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "MasterCatalogueRun" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ProductMatchDismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductMatchDismissal" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ProductMatchDismissal" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ProductMappingImport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductMappingImport" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ProductMappingImport" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

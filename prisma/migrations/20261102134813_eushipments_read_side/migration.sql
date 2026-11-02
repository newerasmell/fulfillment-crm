-- Phase 3 (euShipments read side): new mirror tables only; nothing changes on existing rows.
BEGIN;
-- CreateTable
CREATE TABLE "EushipmentsVendorCompany" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "vendorCompanyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "bulstat" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsVendorCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsCourier" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "courierId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "toOffice" BOOLEAN NOT NULL DEFAULT false,
    "toAddress" BOOLEAN NOT NULL DEFAULT false,
    "country" TEXT,
    "currency" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsCourier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsWarehouse" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "warehouseId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "countryId" INTEGER,
    "countryIso" TEXT,
    "countryName" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsWarehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsCountry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "countryId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "cyrillicName" TEXT,
    "isoCode" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsCountry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsCity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "countryId" INTEGER NOT NULL,
    "cityId" INTEGER NOT NULL,
    "postalCode" TEXT,
    "nameLocal" TEXT NOT NULL,
    "nameEn" TEXT,
    "county" TEXT,
    "countyEn" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsOffice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "officeId" INTEGER NOT NULL,
    "courierId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "cityId" INTEGER,
    "cityName" TEXT,
    "address" TEXT,
    "postCode" TEXT,
    "region" TEXT,
    "isStation" BOOLEAN NOT NULL DEFAULT false,
    "codSupport" BOOLEAN NOT NULL DEFAULT false,
    "latitude" TEXT,
    "longitude" TEXT,
    "workHours" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsOffice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsStock" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "refNumber" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL,
    "vendorProductId" TEXT,
    "availQty" INTEGER NOT NULL,
    "courierItemCode" TEXT,
    "availDate" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsTracking" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "polledAt" TIMESTAMP(3),
    "stopPolling" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "codAmount" TEXT,
    "codAwb" TEXT,
    "codPaidNumber" TEXT,
    "codPaidAt" TIMESTAMP(3),
    "codCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EushipmentsSync" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "info" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "EushipmentsSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EushipmentsVendorCompany_accountId_idx" ON "EushipmentsVendorCompany"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsVendorCompany_accountId_id_key" ON "EushipmentsVendorCompany"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsVendorCompany_connectionId_vendorCompanyId_key" ON "EushipmentsVendorCompany"("connectionId", "vendorCompanyId");

-- CreateIndex
CREATE INDEX "EushipmentsCourier_accountId_idx" ON "EushipmentsCourier"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsCourier_accountId_id_key" ON "EushipmentsCourier"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsCourier_connectionId_courierId_key" ON "EushipmentsCourier"("connectionId", "courierId");

-- CreateIndex
CREATE INDEX "EushipmentsWarehouse_accountId_idx" ON "EushipmentsWarehouse"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsWarehouse_accountId_id_key" ON "EushipmentsWarehouse"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsWarehouse_connectionId_warehouseId_key" ON "EushipmentsWarehouse"("connectionId", "warehouseId");

-- CreateIndex
CREATE INDEX "EushipmentsCountry_accountId_idx" ON "EushipmentsCountry"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsCountry_accountId_id_key" ON "EushipmentsCountry"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsCountry_connectionId_countryId_key" ON "EushipmentsCountry"("connectionId", "countryId");

-- CreateIndex
CREATE INDEX "EushipmentsCity_accountId_connectionId_countryId_idx" ON "EushipmentsCity"("accountId", "connectionId", "countryId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsCity_accountId_id_key" ON "EushipmentsCity"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsCity_connectionId_cityId_key" ON "EushipmentsCity"("connectionId", "cityId");

-- CreateIndex
CREATE INDEX "EushipmentsOffice_accountId_connectionId_courierId_idx" ON "EushipmentsOffice"("accountId", "connectionId", "courierId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsOffice_accountId_id_key" ON "EushipmentsOffice"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsOffice_connectionId_officeId_key" ON "EushipmentsOffice"("connectionId", "officeId");

-- CreateIndex
CREATE INDEX "EushipmentsStock_accountId_connectionId_idx" ON "EushipmentsStock"("accountId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsStock_accountId_id_key" ON "EushipmentsStock"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsStock_connectionId_refNumber_warehouseName_key" ON "EushipmentsStock"("connectionId", "refNumber", "warehouseName");

-- CreateIndex
CREATE INDEX "EushipmentsTracking_accountId_connectionId_stopPolling_poll_idx" ON "EushipmentsTracking"("accountId", "connectionId", "stopPolling", "polledAt");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsTracking_accountId_id_key" ON "EushipmentsTracking"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsTracking_fulfillmentId_key" ON "EushipmentsTracking"("fulfillmentId");

-- CreateIndex
CREATE INDEX "EushipmentsSync_accountId_idx" ON "EushipmentsSync"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsSync_accountId_id_key" ON "EushipmentsSync"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "EushipmentsSync_connectionId_kind_key" ON "EushipmentsSync"("connectionId", "kind");

-- AddForeignKey
ALTER TABLE "EushipmentsVendorCompany" ADD CONSTRAINT "EushipmentsVendorCompany_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsCourier" ADD CONSTRAINT "EushipmentsCourier_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsWarehouse" ADD CONSTRAINT "EushipmentsWarehouse_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsCountry" ADD CONSTRAINT "EushipmentsCountry_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsCity" ADD CONSTRAINT "EushipmentsCity_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsOffice" ADD CONSTRAINT "EushipmentsOffice_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsStock" ADD CONSTRAINT "EushipmentsStock_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsTracking" ADD CONSTRAINT "EushipmentsTracking_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EushipmentsSync" ADD CONSTRAINT "EushipmentsSync_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "EushipmentsVendorCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsVendorCompany" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsVendorCompany" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsCourier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsCourier" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsCourier" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsWarehouse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsWarehouse" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsWarehouse" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsCountry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsCountry" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsCountry" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsCity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsCity" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsCity" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsOffice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsOffice" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsOffice" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsStock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsStock" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsStock" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsTracking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsTracking" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsTracking" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

ALTER TABLE "EushipmentsSync" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsSync" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsSync" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

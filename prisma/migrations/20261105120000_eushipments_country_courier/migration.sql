-- Default euShipments courier per destination country (owner request 2026-11-05). A NEW table only — additive,
-- nothing existing is altered, so it applies cleanly on a database that already holds data.
CREATE TABLE "EushipmentsCountryCourier" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "courierId" INTEGER NOT NULL,
    "serviceName" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EushipmentsCountryCourier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EushipmentsCountryCourier_accountId_id_key" ON "EushipmentsCountryCourier"("accountId", "id");
CREATE UNIQUE INDEX "EushipmentsCountryCourier_accountId_connectionId_country_key" ON "EushipmentsCountryCourier"("accountId", "connectionId", "country");

ALTER TABLE "EushipmentsCountryCourier" ADD CONSTRAINT "EushipmentsCountryCourier_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EushipmentsCountryCourier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EushipmentsCountryCourier" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "EushipmentsCountryCourier" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

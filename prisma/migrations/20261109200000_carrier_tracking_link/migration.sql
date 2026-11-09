-- Tracking link template per courier (owner request 2026-11-09). A NEW table only — additive, nothing existing is
-- altered, so it applies cleanly on a database that already holds data.
CREATE TABLE "CarrierTrackingLink" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "carrierKey" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "urlTemplate" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CarrierTrackingLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CarrierTrackingLink_accountId_id_key" ON "CarrierTrackingLink"("accountId", "id");
CREATE UNIQUE INDEX "CarrierTrackingLink_accountId_carrierKey_key" ON "CarrierTrackingLink"("accountId", "carrierKey");

ALTER TABLE "CarrierTrackingLink" ADD CONSTRAINT "CarrierTrackingLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CarrierTrackingLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CarrierTrackingLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "CarrierTrackingLink" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

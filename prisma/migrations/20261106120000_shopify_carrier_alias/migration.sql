-- Shopify tracking company per warehouse courier name (owner request 2026-11-06). A NEW table only — additive,
-- nothing existing is altered, so it applies cleanly on a database that already holds data.
CREATE TABLE "ShopifyCarrierAlias" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "carrierKey" TEXT NOT NULL,
    "carrierName" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyCarrierAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyCarrierAlias_accountId_id_key" ON "ShopifyCarrierAlias"("accountId", "id");
CREATE UNIQUE INDEX "ShopifyCarrierAlias_accountId_carrierKey_key" ON "ShopifyCarrierAlias"("accountId", "carrierKey");

ALTER TABLE "ShopifyCarrierAlias" ADD CONSTRAINT "ShopifyCarrierAlias_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyCarrierAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShopifyCarrierAlias" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShopifyCarrierAlias" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

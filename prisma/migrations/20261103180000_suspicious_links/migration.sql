-- "Съмнителни връзки" (owner report 2026-11-03): links whose names disagree. A NEW table only — additive, nothing
-- existing is altered, so it applies cleanly on a database that already holds data.
CREATE TABLE "SuspiciousLink" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lineId" TEXT,
    "sourceId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "itemCode" TEXT,
    "productSku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "flagged" BOOLEAN NOT NULL DEFAULT true,
    "nameKey" TEXT NOT NULL,
    "confirmedKey" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuspiciousLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SuspiciousLink_accountId_id_key" ON "SuspiciousLink"("accountId", "id");
CREATE UNIQUE INDEX "SuspiciousLink_accountId_kind_itemId_key" ON "SuspiciousLink"("accountId", "kind", "itemId");
CREATE INDEX "SuspiciousLink_accountId_flagged_idx" ON "SuspiciousLink"("accountId", "flagged");

ALTER TABLE "SuspiciousLink" ADD CONSTRAINT "SuspiciousLink_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SuspiciousLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SuspiciousLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "SuspiciousLink" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

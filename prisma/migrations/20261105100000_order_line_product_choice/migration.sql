-- Hand-picked product for one order line (owner request 2026-11-05). A NEW table only — additive, nothing existing
-- is altered, so it applies cleanly on a database that already holds data.
CREATE TABLE "OrderLineProductChoice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "previousProductId" TEXT,
    "userId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLineProductChoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderLineProductChoice_accountId_id_key" ON "OrderLineProductChoice"("accountId", "id");
CREATE UNIQUE INDEX "OrderLineProductChoice_accountId_orderLineId_key" ON "OrderLineProductChoice"("accountId", "orderLineId");
CREATE INDEX "OrderLineProductChoice_accountId_productId_idx" ON "OrderLineProductChoice"("accountId", "productId");

ALTER TABLE "OrderLineProductChoice" ADD CONSTRAINT "OrderLineProductChoice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLineProductChoice" ADD CONSTRAINT "OrderLineProductChoice_accountId_orderLineId_fkey" FOREIGN KEY ("accountId", "orderLineId") REFERENCES "OrderLine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLineProductChoice" ADD CONSTRAINT "OrderLineProductChoice_accountId_productId_fkey" FOREIGN KEY ("accountId", "productId") REFERENCES "Product"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "OrderLineProductChoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderLineProductChoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderLineProductChoice" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

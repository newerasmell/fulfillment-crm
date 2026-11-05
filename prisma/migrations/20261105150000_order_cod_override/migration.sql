-- A person's manual COD for one order (owner request 2026-11-05). A NEW table only — additive, nothing existing is
-- altered, so it applies cleanly on a database that already holds data.
CREATE TABLE "OrderCodOverride" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "codAmount" DECIMAL(12,2),
    "note" TEXT,
    "userId" TEXT,
    "previous" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCodOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderCodOverride_accountId_id_key" ON "OrderCodOverride"("accountId", "id");
CREATE UNIQUE INDEX "OrderCodOverride_accountId_orderId_key" ON "OrderCodOverride"("accountId", "orderId");

ALTER TABLE "OrderCodOverride" ADD CONSTRAINT "OrderCodOverride_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCodOverride" ADD CONSTRAINT "OrderCodOverride_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderCodOverride" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderCodOverride" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderCodOverride" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

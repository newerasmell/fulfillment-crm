-- "Позволи за тази поръчка" for a phone (owner request 2026-11-18). Additive only: one new table, no column of an
-- existing table changes, so it applies cleanly on a database that already holds data.

-- CreateTable
CREATE TABLE "OrderPhoneWaiver" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "sentPhone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPhoneWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderPhoneWaiver_accountId_id_key" ON "OrderPhoneWaiver"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPhoneWaiver_accountId_orderId_key" ON "OrderPhoneWaiver"("accountId", "orderId");

-- AddForeignKey
ALTER TABLE "OrderPhoneWaiver" ADD CONSTRAINT "OrderPhoneWaiver_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPhoneWaiver" ADD CONSTRAINT "OrderPhoneWaiver_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderPhoneWaiver" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderPhoneWaiver" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderPhoneWaiver" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

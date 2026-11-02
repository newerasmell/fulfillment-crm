-- Phase 4 review track (wave 2): configurable review reason codes. New table only; nothing changes on existing rows.
BEGIN;
-- CreateTable
CREATE TABLE "ReviewReasonCode" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "labelBg" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "decisions" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewReasonCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewReasonCode_accountId_sortOrder_idx" ON "ReviewReasonCode"("accountId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReasonCode_accountId_code_key" ON "ReviewReasonCode"("accountId", "code");

-- AddForeignKey
ALTER TABLE "ReviewReasonCode" ADD CONSTRAINT "ReviewReasonCode_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "ReviewReasonCode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReviewReasonCode" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ReviewReasonCode" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

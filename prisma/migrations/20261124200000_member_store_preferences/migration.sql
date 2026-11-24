-- The stores each member works with (owner request 2026-11-24). Additive only: one new table, nothing existing changes.

-- CreateTable
CREATE TABLE "MemberStorePreference" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "storeIds" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberStorePreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberStorePreference_accountId_id_key" ON "MemberStorePreference"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemberStorePreference_accountId_userId_key" ON "MemberStorePreference"("accountId", "userId");

-- AddForeignKey
ALTER TABLE "MemberStorePreference" ADD CONSTRAINT "MemberStorePreference_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (as every table with accountId).
ALTER TABLE "MemberStorePreference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberStorePreference" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "MemberStorePreference" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

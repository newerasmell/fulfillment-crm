-- Group → companies (P0-13). Additive only: new tables + NULLABLE companyId columns, then a backfill that
-- gives every existing group one company (named like the group) and attaches its stores, connections and
-- orders to it. Safe on databases that already hold rows. companyId becomes NOT NULL in a later migration,
-- once every environment has run this backfill.

-- The tables have FORCE ROW LEVEL SECURITY and this runs as their owner: without the bypass the backfill
-- below would silently touch 0 rows. Session-level here, switched off again at the end.
SELECT set_config('app.bypass_rls', 'on', false);

-- AlterTable
ALTER TABLE "FulfillmentConnection" ADD COLUMN     "companyId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "companyId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "companyId" TEXT;

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalDetails" JSONB,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipCompany" (
    "accountId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "MembershipCompany_pkey" PRIMARY KEY ("membershipId","companyId")
);

-- CreateTable
CREATE TABLE "InvitationCompany" (
    "accountId" TEXT NOT NULL,
    "invitationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "InvitationCompany_pkey" PRIMARY KEY ("invitationId","companyId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_accountId_id_key" ON "Company"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Company_accountId_name_key" ON "Company"("accountId", "name");

-- CreateIndex
CREATE INDEX "MembershipCompany_accountId_idx" ON "MembershipCompany"("accountId");

-- CreateIndex
CREATE INDEX "InvitationCompany_accountId_idx" ON "InvitationCompany"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_accountId_id_key" ON "Invitation"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_accountId_id_key" ON "Membership"("accountId", "id");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCompany" ADD CONSTRAINT "MembershipCompany_accountId_membershipId_fkey" FOREIGN KEY ("accountId", "membershipId") REFERENCES "Membership"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCompany" ADD CONSTRAINT "MembershipCompany_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationCompany" ADD CONSTRAINT "InvitationCompany_accountId_invitationId_fkey" FOREIGN KEY ("accountId", "invitationId") REFERENCES "Invitation"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvitationCompany" ADD CONSTRAINT "InvitationCompany_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentConnection" ADD CONSTRAINT "FulfillmentConnection_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_companyId_fkey" FOREIGN KEY ("accountId", "companyId") REFERENCES "Company"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Tenant isolation for the new tables (same policy as every other accountId table).
ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Company" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "Company" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "MembershipCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipCompany" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "MembershipCompany" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "InvitationCompany" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvitationCompany" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "InvitationCompany" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

-- Backfill: one company per existing group, then attach existing rows to it.
INSERT INTO "Company" ("id", "accountId", "name", "legalDetails", "createdAt", "updatedAt")
SELECT 'co' || replace(gen_random_uuid()::text, '-', ''), a."id", a."name", a."legalDetails", now(), now()
FROM "Account" a
WHERE NOT EXISTS (SELECT 1 FROM "Company" c WHERE c."accountId" = a."id");

UPDATE "Store" t SET "companyId" = (
  SELECT c."id" FROM "Company" c WHERE c."accountId" = t."accountId" ORDER BY c."createdAt", c."id" LIMIT 1
) WHERE t."companyId" IS NULL;

UPDATE "FulfillmentConnection" t SET "companyId" = (
  SELECT c."id" FROM "Company" c WHERE c."accountId" = t."accountId" ORDER BY c."createdAt", c."id" LIMIT 1
) WHERE t."companyId" IS NULL;

UPDATE "Order" t SET "companyId" = (
  SELECT c."id" FROM "Company" c WHERE c."accountId" = t."accountId" ORDER BY c."createdAt", c."id" LIMIT 1
) WHERE t."companyId" IS NULL;

SELECT set_config('app.bypass_rls', 'off', false);

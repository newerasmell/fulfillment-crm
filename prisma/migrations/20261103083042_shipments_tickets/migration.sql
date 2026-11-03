-- Wave 4 shipments track (P10-01 / P10-02): board settings and FHB ticket notifications per shipment.
-- Additive only: three new tables (no existing table is altered), with row-level security like every tenant table.
BEGIN;

-- CreateTable
CREATE TABLE "ShipmentBoardSettings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "delayedDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentBoardSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbTicket" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lastEvent" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "firstEventAt" TIMESTAMP(3) NOT NULL,
    "lastEventAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FhbTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FhbTicketEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FhbTicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentBoardSettings_accountId_key" ON "ShipmentBoardSettings"("accountId");

-- CreateIndex
CREATE INDEX "FhbTicket_accountId_state_lastEventAt_idx" ON "FhbTicket"("accountId", "state", "lastEventAt");

-- CreateIndex
CREATE UNIQUE INDEX "FhbTicket_accountId_id_key" ON "FhbTicket"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FhbTicket_accountId_fulfillmentId_key" ON "FhbTicket"("accountId", "fulfillmentId");

-- CreateIndex
CREATE INDEX "FhbTicketEvent_accountId_ticketId_receivedAt_idx" ON "FhbTicketEvent"("accountId", "ticketId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FhbTicketEvent_webhookEventId_key" ON "FhbTicketEvent"("webhookEventId");

-- AddForeignKey
ALTER TABLE "ShipmentBoardSettings" ADD CONSTRAINT "ShipmentBoardSettings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbTicket" ADD CONSTRAINT "FhbTicket_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbTicket" ADD CONSTRAINT "FhbTicket_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FhbTicketEvent" ADD CONSTRAINT "FhbTicketEvent_accountId_ticketId_fkey" FOREIGN KEY ("accountId", "ticketId") REFERENCES "FhbTicket"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ShipmentBoardSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShipmentBoardSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShipmentBoardSettings" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbTicket" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbTicket" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "FhbTicketEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FhbTicketEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "FhbTicketEvent" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

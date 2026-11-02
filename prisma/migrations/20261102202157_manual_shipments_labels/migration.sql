-- Wave 3 labels (P7-01..03): manual shipments, stored label PDFs, bulk label prints, AWB price quotes.
-- Additive only: five NEW tables, no column on an existing table changes.
BEGIN;

-- CreateTable
CREATE TABLE "ManualShipment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fulfillmentId" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "trackedAt" TIMESTAMP(3),
    "stopTracking" BOOLEAN NOT NULL DEFAULT false,
    "trackError" TEXT,
    "clientRequestId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualShipmentSequence" (
    "accountId" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1001,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualShipmentSequence_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "ShipmentLabel" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fulfillmentId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'single',
    "format" TEXT NOT NULL DEFAULT 'PDF',
    "source" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "fulfillmentIds" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelPrintJob" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "fulfillmentIds" TEXT[],
    "labelId" TEXT,
    "errors" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "LabelPrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingQuote" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "response" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ShippingQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualShipment_accountId_createdAt_idx" ON "ManualShipment"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualShipment_accountId_kind_stopTracking_idx" ON "ManualShipment"("accountId", "kind", "stopTracking");

-- CreateIndex
CREATE UNIQUE INDEX "ManualShipment_accountId_id_key" ON "ManualShipment"("accountId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ManualShipment_accountId_orderId_key" ON "ManualShipment"("accountId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualShipment_accountId_fulfillmentId_key" ON "ManualShipment"("accountId", "fulfillmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualShipment_accountId_clientRequestId_key" ON "ManualShipment"("accountId", "clientRequestId");

-- CreateIndex
CREATE INDEX "ShipmentLabel_accountId_fulfillmentId_createdAt_idx" ON "ShipmentLabel"("accountId", "fulfillmentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLabel_accountId_id_key" ON "ShipmentLabel"("accountId", "id");

-- CreateIndex
CREATE INDEX "LabelPrintJob_accountId_createdAt_idx" ON "LabelPrintJob"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LabelPrintJob_accountId_id_key" ON "LabelPrintJob"("accountId", "id");

-- CreateIndex
CREATE INDEX "ShippingQuote_accountId_createdAt_idx" ON "ShippingQuote"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingQuote_accountId_id_key" ON "ShippingQuote"("accountId", "id");

-- AddForeignKey
ALTER TABLE "ManualShipment" ADD CONSTRAINT "ManualShipment_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualShipment" ADD CONSTRAINT "ManualShipment_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualShipment" ADD CONSTRAINT "ManualShipment_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLabel" ADD CONSTRAINT "ShipmentLabel_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentLabel" ADD CONSTRAINT "ShipmentLabel_accountId_fulfillmentId_fkey" FOREIGN KEY ("accountId", "fulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelPrintJob" ADD CONSTRAINT "LabelPrintJob_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingQuote" ADD CONSTRAINT "ShippingQuote_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "ManualShipment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManualShipment" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ManualShipment" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ManualShipmentSequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManualShipmentSequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ManualShipmentSequence" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ShipmentLabel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShipmentLabel" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShipmentLabel" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "LabelPrintJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LabelPrintJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "LabelPrintJob" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "ShippingQuote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ShippingQuote" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "ShippingQuote" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

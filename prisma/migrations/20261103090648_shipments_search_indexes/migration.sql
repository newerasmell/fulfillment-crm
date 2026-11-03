-- Wave 4 shipments track: indexes for the Товарителници board (audit finding). Additive only: no table or column
-- changes, so it is safe against existing rows. pg_trgm is a trusted contrib extension (Render Postgres supports
-- it) and serves the board's ILIKE '%q%' search on order number, customer name and our shipment id.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Fulfillment_accountId_createdAt_id_idx" ON "Fulfillment"("accountId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Fulfillment_accountId_orderId_idx" ON "Fulfillment"("accountId", "orderId");

-- CreateIndex
CREATE INDEX "Fulfillment_trackingNumbers_idx" ON "Fulfillment" USING GIN ("trackingNumbers");

-- CreateIndex
CREATE INDEX "Fulfillment_externalId_idx" ON "Fulfillment" USING GIN ("externalId" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Order_number_idx" ON "Order" USING GIN ("number" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Order_customerName_idx" ON "Order" USING GIN ("customerName" gin_trgm_ops);

COMMIT;

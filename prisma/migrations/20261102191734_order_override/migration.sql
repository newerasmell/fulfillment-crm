-- Wave 3 override track (P4-09): manual warehouse choice ("Изпрати от") and reroute after sending
-- ("Пренасочи към друг склад"). Additive only: two NEW tables and two triggers. Nothing existing is altered or
-- backfilled, and the triggers only check rows written from now on, so this applies on a database that already
-- holds orders and shipments (tests/unit/migrations.test.ts seeds two active shipments of one order on purpose).
BEGIN;

-- CreateTable
CREATE TABLE "OrderWarehouseChoice" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "via" TEXT NOT NULL DEFAULT 'manual',
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "chosenById" TEXT,
    "rerouteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderWarehouseChoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReroute" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromFulfillmentId" TEXT NOT NULL,
    "fromConnectionId" TEXT NOT NULL,
    "toConnectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANCEL_QUEUED',
    "cancelRequestId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "requestedById" TEXT,
    "outcome" JSONB NOT NULL DEFAULT '{}',
    "readBackAttempts" INTEGER NOT NULL DEFAULT 0,
    "alertId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OrderReroute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderWarehouseChoice_accountId_connectionId_idx" ON "OrderWarehouseChoice"("accountId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderWarehouseChoice_accountId_orderId_key" ON "OrderWarehouseChoice"("accountId", "orderId");

-- CreateIndex
CREATE INDEX "OrderReroute_accountId_orderId_createdAt_idx" ON "OrderReroute"("accountId", "orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderReroute_status_updatedAt_idx" ON "OrderReroute"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReroute_accountId_id_key" ON "OrderReroute"("accountId", "id");

-- AddForeignKey
ALTER TABLE "OrderWarehouseChoice" ADD CONSTRAINT "OrderWarehouseChoice_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderWarehouseChoice" ADD CONSTRAINT "OrderWarehouseChoice_accountId_connectionId_fkey" FOREIGN KEY ("accountId", "connectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReroute" ADD CONSTRAINT "OrderReroute_accountId_orderId_fkey" FOREIGN KEY ("accountId", "orderId") REFERENCES "Order"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReroute" ADD CONSTRAINT "OrderReroute_accountId_fromFulfillmentId_fkey" FOREIGN KEY ("accountId", "fromFulfillmentId") REFERENCES "Fulfillment"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReroute" ADD CONSTRAINT "OrderReroute_accountId_toConnectionId_fkey" FOREIGN KEY ("accountId", "toConnectionId") REFERENCES "FulfillmentConnection"("accountId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Never two active shipments of one order (CLAUDE.md: never a duplicate shipment). "Active" = everything but
-- SUBMIT_FAILED / CANCELLED, the same set the pipeline guards use (src/server/pipeline/transition.ts). Checked when a
-- row is inserted active, or an inactive row becomes active again (re-armed submit). The order row is locked first,
-- so two concurrent writers for the same order are serialised and the second one sees the first one's row.
-- NOTE: a future reship after delivery/return must relax this deliberately (it is a second shipment by design).
CREATE OR REPLACE FUNCTION crm_fulfillment_one_active() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('SUBMIT_FAILED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status NOT IN ('SUBMIT_FAILED', 'CANCELLED') AND OLD."orderId" = NEW."orderId" THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "Order" o WHERE o.id = NEW."orderId" FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM "Fulfillment" f
    WHERE f."orderId" = NEW."orderId" AND f.id <> NEW.id AND f.status NOT IN ('SUBMIT_FAILED', 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'crm_two_active_shipments: order % already has an active shipment', NEW."orderId"
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fulfillment_one_active BEFORE INSERT OR UPDATE OF status, "orderId" ON "Fulfillment"
  FOR EACH ROW EXECUTE FUNCTION crm_fulfillment_one_active();

-- At most one open reroute (CANCEL_QUEUED) per order, same locking.
CREATE OR REPLACE FUNCTION crm_order_reroute_one_open() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'CANCEL_QUEUED' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "Order" o WHERE o.id = NEW."orderId" FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM "OrderReroute" r
    WHERE r."orderId" = NEW."orderId" AND r.id <> NEW.id AND r.status = 'CANCEL_QUEUED'
  ) THEN
    RAISE EXCEPTION 'crm_reroute_open: order % already has an open reroute', NEW."orderId"
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER order_reroute_one_open BEFORE INSERT OR UPDATE OF status ON "OrderReroute"
  FOR EACH ROW EXECUTE FUNCTION crm_order_reroute_one_open();

-- Row-level security, same policy as every other account-scoped table (see the rls migration).
ALTER TABLE "OrderWarehouseChoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderWarehouseChoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderWarehouseChoice" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));
ALTER TABLE "OrderReroute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderReroute" FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON "OrderReroute" USING (crm_rls_allows("accountId")) WITH CHECK (crm_rls_allows("accountId"));

COMMIT;

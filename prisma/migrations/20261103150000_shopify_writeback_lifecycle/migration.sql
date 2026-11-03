-- Owner request 2026-11-03: the whole Shopify lifecycle per shipment (fulfil → tracking updates → fulfillment events).
-- Additive and safe on existing rows: a new enum-typed store setting with a default that keeps today's behaviour
-- (ON_TRACKING), two new ShopifyWriteBack columns with defaults (every existing row is the shipment's FULFIL row,
-- value ""), trackingNumber becomes nullable (fulfil on acceptance, before tracking exists). The unique guard widens
-- from one row per shipment to one row per shipment + kind + value; the new index is created before the old one is
-- dropped, and existing rows satisfy it (they were unique per shipment and all get kind FULFIL / value "").
BEGIN;
CREATE TYPE "ShopifyFulfilTrigger" AS ENUM ('ON_TRACKING', 'ON_ACCEPT');
CREATE TYPE "ShopifyWriteBackKind" AS ENUM ('FULFIL', 'TRACKING', 'EVENT');
ALTER TABLE "Store" ADD COLUMN "fulfilTrigger" "ShopifyFulfilTrigger" NOT NULL DEFAULT 'ON_TRACKING';
ALTER TABLE "ShopifyWriteBack" ADD COLUMN "kind" "ShopifyWriteBackKind" NOT NULL DEFAULT 'FULFIL';
ALTER TABLE "ShopifyWriteBack" ADD COLUMN "value" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopifyWriteBack" ALTER COLUMN "trackingNumber" DROP NOT NULL;
CREATE UNIQUE INDEX "ShopifyWriteBack_accountId_fulfillmentId_kind_value_key"
  ON "ShopifyWriteBack"("accountId", "fulfillmentId", "kind", "value");
DROP INDEX "ShopifyWriteBack_accountId_fulfillmentId_key";
COMMIT;

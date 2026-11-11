-- Delivery to a courier office (owner request 2026-11-11). Additive, nullable: safe on tables with rows.
ALTER TABLE "Order" ADD COLUMN "deliveryOffice" JSONB;
ALTER TABLE "EushipmentsOffice" ADD COLUMN "courierOfficeId" INTEGER;

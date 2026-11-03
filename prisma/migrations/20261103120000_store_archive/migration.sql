-- Store archive (Магазини → Архивирай). Additive only: two nullable columns, safe on existing rows.
ALTER TABLE "Store" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "Store" ADD COLUMN "archivedById" TEXT;

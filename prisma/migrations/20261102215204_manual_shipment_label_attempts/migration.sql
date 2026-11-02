-- Wave 3 labels audit fix: cap the AWB label fetch retries (attempt counter + last error on ManualShipment).
-- Additive only: two columns, the NOT NULL one has a default (safe for existing rows).
BEGIN;

-- AlterTable
ALTER TABLE "ManualShipment" ADD COLUMN     "labelAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "labelError" TEXT;

COMMIT;

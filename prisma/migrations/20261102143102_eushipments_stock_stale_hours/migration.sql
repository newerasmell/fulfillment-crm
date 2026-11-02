BEGIN;

-- AlterTable (additive: NOT NULL with a default, safe for existing rows)
ALTER TABLE "EushipmentsSettings" ADD COLUMN     "stockStaleHours" INTEGER NOT NULL DEFAULT 30;

COMMIT;

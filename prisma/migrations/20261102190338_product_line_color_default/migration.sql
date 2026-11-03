-- Wave 3 core (P5-00) audit fix: ProductLine.color defaulted to 'indigo', which is not a colour token
-- (src/server/lines/colors.ts). Only the default changes; existing rows keep their value (UI maps unknown → rose).
BEGIN;

-- AlterTable
ALTER TABLE "ProductLine" ALTER COLUMN "color" SET DEFAULT 'rose';

COMMIT;

-- "Липсващи артикули": automatic out_of_stock tag per store (owner request 2026-11-11). Additive only: one nullable
-- column (null = off) on Store, so it applies cleanly on a database that already holds data.
ALTER TABLE "Store" ADD COLUMN "outOfStockAutoTagSince" TIMESTAMP(3);

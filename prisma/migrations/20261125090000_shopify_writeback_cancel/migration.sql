-- Additive only: a new write-back kind (no existing row changes).
ALTER TYPE "ShopifyWriteBackKind" ADD VALUE IF NOT EXISTS 'CANCEL';

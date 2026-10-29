/*
  Warnings:

  - You are about to drop the column `pendingTotpSecretEnc` on the `Invitation` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "OutboundStatus" ADD VALUE 'HELD';

-- AlterTable
ALTER TABLE "Invitation" DROP COLUMN "pendingTotpSecretEnc";

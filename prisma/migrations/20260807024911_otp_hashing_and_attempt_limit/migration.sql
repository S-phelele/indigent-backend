/*
  Warnings:

  - You are about to drop the column `code` on the `Otp` table. All the data in the column will be lost.
  - Added the required column `codeHash` to the `Otp` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('VERIFY_CELL', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "Otp" DROP COLUMN "code",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeHash" TEXT NOT NULL,
ADD COLUMN     "purpose" "OtpPurpose" NOT NULL DEFAULT 'VERIFY_CELL';

-- CreateIndex
CREATE INDEX "Otp_cellNumber_purpose_idx" ON "Otp"("cellNumber", "purpose");

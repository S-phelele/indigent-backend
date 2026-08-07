-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'PROOF_OF_INCOME';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_CREATED_FOR_YOU';
ALTER TYPE "NotificationType" ADD VALUE 'COUNCILLOR_CAPTURE';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'COUNCILLOR';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "captureChannel" TEXT NOT NULL DEFAULT 'SELF',
ADD COLUMN     "capturedAt" TIMESTAMP(3),
ADD COLUMN     "capturedById" TEXT,
ADD COLUMN     "capturedWard" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "requirementGroup" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "registeredById" TEXT,
ADD COLUMN     "ward" TEXT;

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "SmsStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "error" TEXT,
    "userId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "segments" INTEGER NOT NULL DEFAULT 1,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsMessage_toNumber_idx" ON "SmsMessage"("toNumber");

-- CreateIndex
CREATE INDEX "SmsMessage_createdAt_idx" ON "SmsMessage"("createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_status_idx" ON "SmsMessage"("status");

-- CreateIndex
CREATE INDEX "Application_capturedById_idx" ON "Application"("capturedById");

-- CreateIndex
CREATE INDEX "Application_captureChannel_idx" ON "Application"("captureChannel");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


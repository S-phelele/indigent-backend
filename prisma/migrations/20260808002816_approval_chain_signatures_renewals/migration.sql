-- CreateEnum
CREATE TYPE "ApprovalStage" AS ENUM ('NOT_SUBMITTED', 'VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF', 'COMPLETE');

-- CreateEnum
CREATE TYPE "StepOutcome" AS ENUM ('PENDING', 'RECOMMEND_APPROVE', 'RECOMMEND_REJECT', 'APPROVED', 'REJECTED', 'RETURNED');

-- CreateEnum
CREATE TYPE "MeansTestResult" AS ENUM ('QUALIFIES', 'ABOVE_THRESHOLD', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('NOT_APPLICABLE', 'ACTIVE', 'DUE_SOON', 'OVERDUE', 'LAPSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'AWAITING_ASSESSMENT';
ALTER TYPE "NotificationType" ADD VALUE 'AWAITING_SIGNOFF';
ALTER TYPE "NotificationType" ADD VALUE 'RETURNED_FOR_REWORK';
ALTER TYPE "NotificationType" ADD VALUE 'RENEWAL_DUE';
ALTER TYPE "NotificationType" ADD VALUE 'RENEWAL_OVERDUE';
ALTER TYPE "NotificationType" ADD VALUE 'REGISTRATION_LAPSED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'ASSESSMENT_OFFICER';
ALTER TYPE "Role" ADD VALUE 'SUPERVISOR';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "approvalStage" "ApprovalStage" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "assessedAt" TIMESTAMP(3),
ADD COLUMN     "assessedById" TEXT,
ADD COLUMN     "assessedIncome" DECIMAL(12,2),
ADD COLUMN     "assessedPerPerson" DECIMAL(12,2),
ADD COLUMN     "assessmentNotes" TEXT,
ADD COLUMN     "budgetConfirmed" BOOLEAN,
ADD COLUMN     "budgetNotes" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "lastRenewedAt" TIMESTAMP(3),
ADD COLUMN     "meansTestResult" "MeansTestResult",
ADD COLUMN     "renewalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "renewalNotifiedLevel" TEXT,
ADD COLUMN     "renewalStatus" "RenewalStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "signOffNotes" TEXT,
ADD COLUMN     "signedOffAt" TIMESTAMP(3),
ADD COLUMN     "signedOffById" TEXT;

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "stage" "ApprovalStage" NOT NULL,
    "outcome" "StepOutcome" NOT NULL DEFAULT 'PENDING',
    "sequence" INTEGER NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "notes" TEXT,
    "returnedTo" "ApprovalStage",
    "returnReason" TEXT,
    "signature" TEXT,
    "signatureName" TEXT,
    "signedAt" TIMESTAMP(3),
    "signatureIp" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldChange" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "atStage" "ApprovalStage",
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalStep_applicationId_sequence_idx" ON "ApprovalStep"("applicationId", "sequence");

-- CreateIndex
CREATE INDEX "ApprovalStep_stage_outcome_idx" ON "ApprovalStep"("stage", "outcome");

-- CreateIndex
CREATE INDEX "ApprovalStep_actorId_idx" ON "ApprovalStep"("actorId");

-- CreateIndex
CREATE INDEX "FieldChange_applicationId_createdAt_idx" ON "FieldChange"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "FieldChange_field_idx" ON "FieldChange"("field");

-- CreateIndex
CREATE INDEX "FieldChange_actorId_idx" ON "FieldChange"("actorId");

-- CreateIndex
CREATE INDEX "Application_approvalStage_idx" ON "Application"("approvalStage");

-- CreateIndex
CREATE INDEX "Application_expiresAt_idx" ON "Application"("expiresAt");

-- CreateIndex
CREATE INDEX "Application_renewalStatus_idx" ON "Application"("renewalStatus");

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldChange" ADD CONSTRAINT "FieldChange_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;


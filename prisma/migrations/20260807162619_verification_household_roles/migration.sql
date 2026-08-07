-- CreateEnum
CREATE TYPE "Tenure" AS ENUM ('OWNER', 'TENANT', 'OCCUPIER');

-- CreateEnum
CREATE TYPE "IncomeEvidence" AS ENUM ('PROOF_OF_INCOME', 'BANK_STATEMENTS', 'AFFIDAVIT');

-- CreateEnum
CREATE TYPE "ApplicantCategory" AS ENUM ('STANDARD', 'PENSIONER', 'DECEASED_ESTATE', 'CHILD_HEADED', 'DISABLED');

-- CreateEnum
CREATE TYPE "Recommendation" AS ENUM ('APPROVE', 'REJECT', 'ESCALATE');

-- CreateEnum
CREATE TYPE "VerificationStage" AS ENUM ('NOT_STARTED', 'IN_VERIFICATION', 'AWAITING_INFORMATION', 'RECOMMENDED', 'COMPLETE');

-- CreateEnum
CREATE TYPE "SiteVisitOutcome" AS ENUM ('SCHEDULED', 'VERIFIED', 'NO_ACCESS', 'OCCUPANT_ABSENT', 'ADDRESS_NOT_FOUND', 'DETAILS_DISPUTED');

-- CreateEnum
CREATE TYPE "CheckSource" AS ENUM ('SARS', 'UIF', 'SASSA', 'CREDIT_BUREAU', 'DEEDS_OFFICE', 'MUNICIPAL_ACCOUNT', 'OTHER');

-- CreateEnum
CREATE TYPE "CheckOutcome" AS ENUM ('PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_APPLICABLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentType" ADD VALUE 'PROOF_OF_OWNERSHIP';
ALTER TYPE "DocumentType" ADD VALUE 'LEASE_AGREEMENT';
ALTER TYPE "DocumentType" ADD VALUE 'MUNICIPAL_STATEMENT';
ALTER TYPE "DocumentType" ADD VALUE 'BIRTH_CERTIFICATE';
ALTER TYPE "DocumentType" ADD VALUE 'GUARDIANSHIP_ORDER';
ALTER TYPE "DocumentType" ADD VALUE 'SOCIAL_WORKER_LETTER';
ALTER TYPE "DocumentType" ADD VALUE 'DIVORCE_DECREE';
ALTER TYPE "DocumentType" ADD VALUE 'MARRIAGE_CERTIFICATE';
ALTER TYPE "DocumentType" ADD VALUE 'DISABILITY_CERTIFICATE';
ALTER TYPE "DocumentType" ADD VALUE 'COUNCILLOR_MOTIVATION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SITE_VISIT_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'SITE_VISIT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'RECOMMENDATION_READY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'CAPTURE_OFFICER';
ALTER TYPE "Role" ADD VALUE 'VERIFICATION_OFFICER';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "applicantCategory" "ApplicantCategory" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "capturedOnBehalf" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consentDataMatching" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "consentGivenAt" TIMESTAMP(3),
ADD COLUMN     "consentSiteVisit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "declarationTruthful" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "eskomAccountNumber" TEXT,
ADD COLUMN     "failedVisitCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "incomeEvidence" "IncomeEvidence",
ADD COLUMN     "incomeExclusions" TEXT,
ADD COLUMN     "municipalAccountNumber" TEXT,
ADD COLUMN     "otherPropertyDetails" TEXT,
ADD COLUMN     "ownsOtherProperty" BOOLEAN,
ADD COLUMN     "recommendation" "Recommendation",
ADD COLUMN     "recommendationNotes" TEXT,
ADD COLUMN     "recommendedAt" TIMESTAMP(3),
ADD COLUMN     "recommendedById" TEXT,
ADD COLUMN     "tenure" "Tenure",
ADD COLUMN     "verificationStage" "VerificationStage" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "wardNumber" TEXT,
ADD COLUMN     "witnessIdNumber" TEXT,
ADD COLUMN     "witnessName" TEXT,
ADD COLUMN     "witnessSignedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "HouseholdMember" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "relationship" TEXT,
    "idNumber" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "age" INTEGER,
    "monthlyIncome" DECIMAL(12,2),
    "isDependant" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteVisit" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "visitedAt" TIMESTAMP(3),
    "outcome" "SiteVisitOutcome" NOT NULL DEFAULT 'SCHEDULED',
    "officerId" TEXT,
    "officerName" TEXT,
    "findings" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationCheck" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "source" "CheckSource" NOT NULL,
    "outcome" "CheckOutcome" NOT NULL DEFAULT 'INCONCLUSIVE',
    "externalRef" TEXT,
    "findings" TEXT,
    "amountFound" DECIMAL(12,2),
    "officerId" TEXT,
    "officerName" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HouseholdMember_applicationId_idx" ON "HouseholdMember"("applicationId");

-- CreateIndex
CREATE INDEX "SiteVisit_applicationId_idx" ON "SiteVisit"("applicationId");

-- CreateIndex
CREATE INDEX "SiteVisit_outcome_idx" ON "SiteVisit"("outcome");

-- CreateIndex
CREATE UNIQUE INDEX "SiteVisit_applicationId_attempt_key" ON "SiteVisit"("applicationId", "attempt");

-- CreateIndex
CREATE INDEX "VerificationCheck_applicationId_idx" ON "VerificationCheck"("applicationId");

-- CreateIndex
CREATE INDEX "VerificationCheck_source_idx" ON "VerificationCheck"("source");

-- CreateIndex
CREATE INDEX "Application_verificationStage_idx" ON "Application"("verificationStage");

-- CreateIndex
CREATE INDEX "Application_wardNumber_idx" ON "Application"("wardNumber");

-- CreateIndex
CREATE INDEX "Application_status_submittedAt_idx" ON "Application"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "Application_reference_idx" ON "Application"("reference");

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCheck" ADD CONSTRAINT "VerificationCheck_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;


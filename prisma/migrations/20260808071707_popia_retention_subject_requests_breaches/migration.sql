-- CreateEnum
CREATE TYPE "SubjectRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'DELETION', 'OBJECTION');

-- CreateEnum
CREATE TYPE "SubjectRequestStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REFUSED');

-- CreateEnum
CREATE TYPE "BreachSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('DETECTED', 'INVESTIGATING', 'CONTAINED', 'NOTIFIED', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SUBJECT_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'SUBJECT_REQUEST_ANSWERED';

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "anonymisedAt" TIMESTAMP(3),
ADD COLUMN     "anonymisedUnder" TEXT;

-- CreateTable
CREATE TABLE "SubjectRequest" (
    "id" TEXT NOT NULL,
    "type" "SubjectRequestType" NOT NULL,
    "status" "SubjectRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "subjectUserId" TEXT,
    "subjectName" TEXT,
    "subjectEmail" TEXT,
    "subjectIdNumber" TEXT,
    "request" TEXT NOT NULL,
    "correctionDetail" TEXT,
    "handledById" TEXT,
    "handledByName" TEXT,
    "responseNotes" TEXT,
    "refusalGround" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataBreach" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "BreachSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "BreachStatus" NOT NULL DEFAULT 'DETECTED',
    "dataAffected" TEXT,
    "peopleAffected" INTEGER,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurredAt" TIMESTAMP(3),
    "containedAt" TIMESTAMP(3),
    "regulatorNotifiedAt" TIMESTAMP(3),
    "subjectsNotifiedAt" TIMESTAMP(3),
    "reportedById" TEXT,
    "reportedByName" TEXT,
    "remediation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataBreach_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubjectRequest_status_receivedAt_idx" ON "SubjectRequest"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "SubjectRequest_subjectUserId_idx" ON "SubjectRequest"("subjectUserId");

-- CreateIndex
CREATE INDEX "SubjectRequest_subjectIdNumber_idx" ON "SubjectRequest"("subjectIdNumber");

-- CreateIndex
CREATE INDEX "DataBreach_status_detectedAt_idx" ON "DataBreach"("status", "detectedAt");

-- CreateIndex
CREATE INDEX "DataBreach_severity_idx" ON "DataBreach"("severity");

-- CreateIndex
CREATE INDEX "Application_anonymisedAt_idx" ON "Application"("anonymisedAt");

-- CreateIndex
CREATE INDEX "Application_status_reviewedAt_idx" ON "Application"("status", "reviewedAt");


-- The whole database, in one migration.
--
-- This replaces nineteen incremental migrations written while the register was
-- being built. They were correct, but a new developer had to replay every one of
-- them in order, and a single failure part-way through left a half-built
-- database that looked like the application was broken. One baseline either
-- applies or it does not.
--
-- ## Two halves, and why the second one exists
--
-- Everything above the rule below is generated from `schema.prisma` and can be
-- regenerated at any time. Everything after it cannot be: the append-only
-- guarantees on the audit trail are PostgreSQL functions and triggers, and
-- Prisma's schema language has no way to express them.
--
-- That is the trap this file exists to avoid. Squashing by regenerating from the
-- schema alone produces tables that look correct and silently drops all eight
-- triggers — so a fresh database would let anybody edit the audit trail, a
-- compliance guarantee lost with no error and nothing on screen to notice.
--
-- If you add a trigger, function, view or grant, add it after the rule. Anything
-- not expressible in schema.prisma has to live there, or it will not survive the
-- next time this is squashed.
--
-- The three data migrations from the old history are deliberately gone. They
-- backfilled rows that existed at the time; against an empty database they have
-- nothing to do.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('APPLICANT', 'COUNCILLOR', 'CAPTURE_OFFICER', 'VERIFICATION_OFFICER', 'ASSESSMENT_OFFICER', 'SUPERVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ApprovalStage" AS ENUM ('NOT_SUBMITTED', 'VERIFICATION', 'ASSESSMENT', 'SUPERVISOR_SIGNOFF', 'COMPLETE');

-- CreateEnum
CREATE TYPE "StepOutcome" AS ENUM ('PENDING', 'RECOMMEND_APPROVE', 'RECOMMEND_REJECT', 'APPROVED', 'REJECTED', 'RETURNED');

-- CreateEnum
CREATE TYPE "MeansTestResult" AS ENUM ('QUALIFIES', 'ABOVE_THRESHOLD', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('NOT_APPLICABLE', 'ACTIVE', 'DUE_SOON', 'OVERDUE', 'LAPSED');

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

-- CreateEnum
CREATE TYPE "DifficultyLevel" AS ENUM ('NO_DIFFICULTY', 'SOME_DIFFICULTY', 'A_LOT_OF_DIFFICULTY', 'CANNOT_DO_AT_ALL');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('FEMALE', 'MALE');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'SEPARATED');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('EMPLOYED', 'UNEMPLOYED', 'SELF_EMPLOYED', 'PENSIONER', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('ID_COPY', 'BANK_STATEMENTS', 'AFFIDAVIT', 'PROOF_OF_GRANT', 'COPY_OF_DEATH_CERT', 'LETTER_OF_AUTHORITY', 'PROOF_OF_INCOME', 'PROOF_OF_OWNERSHIP', 'LEASE_AGREEMENT', 'MUNICIPAL_STATEMENT', 'BIRTH_CERTIFICATE', 'GUARDIANSHIP_ORDER', 'SOCIAL_WORKER_LETTER', 'DIVORCE_DECREE', 'MARRIAGE_CERTIFICATE', 'DISABILITY_CERTIFICATE', 'COUNCILLOR_MOTIVATION', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentImportance" AS ENUM ('REQUIRED', 'OPTIONAL');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('VERIFY_CELL', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPLICATION_SUBMITTED', 'APPLICATION_APPROVED', 'APPLICATION_DECLINED', 'APPLICATION_REOPENED', 'DOCUMENT_REJECTED', 'DOCUMENT_ACCEPTED', 'APPLICATION_UPDATED', 'WELCOME', 'ACCOUNT_CREATED_FOR_YOU', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_FAILED', 'INFORMATION_REQUESTED', 'NEW_REGISTRATION', 'NEW_APPLICATION', 'APPLICATION_AWAITING_REVIEW', 'APPLICATION_AT_RISK', 'APPLICATION_BREACHED', 'COUNCILLOR_CAPTURE', 'RECOMMENDATION_READY', 'SUBJECT_REQUEST', 'SUBJECT_REQUEST_ANSWERED', 'AWAITING_ASSESSMENT', 'AWAITING_SIGNOFF', 'RETURNED_FOR_REWORK', 'RENEWAL_DUE', 'RENEWAL_OVERDUE', 'REGISTRATION_LAPSED', 'ACCOUNT_LOCKED', 'APPROVAL_ACTIVITY');

-- CreateEnum
CREATE TYPE "SubjectRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'DELETION', 'OBJECTION');

-- CreateEnum
CREATE TYPE "SubjectRequestStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REFUSED');

-- CreateEnum
CREATE TYPE "BreachSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('DETECTED', 'INVESTIGATING', 'CONTAINED', 'NOTIFIED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SmsStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'APPLICANT',
    "firstName" TEXT,
    "lastName" TEXT,
    "cellNumber" TEXT,
    "idNumber" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "ward" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "registeredById" TEXT,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastFailedLoginAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "passwordChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Otp" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "cellNumber" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL DEFAULT 'VERIFY_CELL',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "employmentStatus" "EmploymentStatus",
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT,
    "maritalStatus" "MaritalStatus",
    "surname" TEXT,
    "names" TEXT,
    "idNumber" TEXT,
    "cellNumber" TEXT,
    "residentialAddress" TEXT,
    "postalAddress" TEXT,
    "postalSameAsResidential" BOOLEAN NOT NULL DEFAULT false,
    "postalLine1" TEXT,
    "postalLine2" TEXT,
    "postalSuburb" TEXT,
    "postalCity" TEXT,
    "postalCode" TEXT,
    "addressLatitude" DECIMAL(10,7),
    "addressLongitude" DECIMAL(10,7),
    "addressFormatted" TEXT,
    "addressSource" TEXT,
    "addressAccuracyM" INTEGER,
    "addressVerifiedAt" TIMESTAMP(3),
    "employerName" TEXT,
    "employerAddress" TEXT,
    "workTelNumber" TEXT,
    "cellVerified" BOOLEAN NOT NULL DEFAULT false,
    "dateOfBirth" TIMESTAMP(3),
    "age" INTEGER,
    "sex" "Sex",
    "difficultySeeing" "DifficultyLevel",
    "difficultyHearing" "DifficultyLevel",
    "difficultyWalking" "DifficultyLevel",
    "difficultyRemembering" "DifficultyLevel",
    "difficultySelfCare" "DifficultyLevel",
    "difficultyCommunicating" "DifficultyLevel",
    "hasDisability" BOOLEAN,
    "anonymisedAt" TIMESTAMP(3),
    "anonymisedUnder" TEXT,
    "wardNumber" TEXT,
    "peopleOnProperty" INTEGER,
    "childrenUnder18" INTEGER,
    "adults" INTEGER,
    "pensionersOver60" INTEGER,
    "waterMeterNumber" TEXT,
    "electricityMeterNumber" TEXT,
    "municipalAccountNumber" TEXT,
    "eskomAccountNumber" TEXT,
    "tenure" "Tenure",
    "ownsOtherProperty" BOOLEAN,
    "otherPropertyDetails" TEXT,
    "salary" DECIMAL(12,2),
    "oldAgePension" DECIMAL(12,2),
    "disabilityPension" DECIMAL(12,2),
    "businessIncome" DECIMAL(12,2),
    "rentingIncome" DECIMAL(12,2),
    "totalIncomePerPerson" DECIMAL(12,2),
    "totalHouseholdIncome" DECIMAL(12,2),
    "ownsImmovableProperty" BOOLEAN,
    "isFullTimeOccupant" BOOLEAN,
    "incomeBelowThreshold" BOOLEAN,
    "hasMunicipalArrears" BOOLEAN,
    "hasArrearsArrangement" BOOLEAN,
    "incomeThresholdApplied" DECIMAL(12,2),
    "incomeEvidence" "IncomeEvidence",
    "incomeExclusions" TEXT,
    "applicantCategory" "ApplicantCategory" NOT NULL DEFAULT 'STANDARD',
    "consentSiteVisit" BOOLEAN NOT NULL DEFAULT false,
    "consentDataMatching" BOOLEAN NOT NULL DEFAULT false,
    "declarationTruthful" BOOLEAN NOT NULL DEFAULT false,
    "consentGivenAt" TIMESTAMP(3),
    "verificationStage" "VerificationStage" NOT NULL DEFAULT 'NOT_STARTED',
    "failedVisitCount" INTEGER NOT NULL DEFAULT 0,
    "recommendation" "Recommendation",
    "recommendedById" TEXT,
    "recommendedAt" TIMESTAMP(3),
    "recommendationNotes" TEXT,
    "approvalStage" "ApprovalStage" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "meansTestResult" "MeansTestResult",
    "assessedIncome" DECIMAL(12,2),
    "assessedPerPerson" DECIMAL(12,2),
    "assessmentNotes" TEXT,
    "assessedById" TEXT,
    "assessedAt" TIMESTAMP(3),
    "budgetConfirmed" BOOLEAN,
    "budgetNotes" TEXT,
    "signedOffById" TEXT,
    "signedOffAt" TIMESTAMP(3),
    "signOffNotes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "renewalStatus" "RenewalStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "renewalNotifiedLevel" TEXT,
    "renewalCount" INTEGER NOT NULL DEFAULT 0,
    "lastRenewedAt" TIMESTAMP(3),
    "capturedOnBehalf" BOOLEAN NOT NULL DEFAULT false,
    "witnessName" TEXT,
    "witnessIdNumber" TEXT,
    "witnessSignedAt" TIMESTAMP(3),
    "reference" TEXT,
    "slaNotifiedLevel" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewNotes" TEXT,
    "captureChannel" TEXT NOT NULL DEFAULT 'SELF',
    "capturedById" TEXT,
    "capturedAt" TIMESTAMP(3),
    "capturedWard" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT,
    "userRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "importance" "DocumentImportance" NOT NULL DEFAULT 'REQUIRED',
    "requirementGroup" TEXT,
    "fileName" TEXT,
    "filePath" TEXT,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_idNumber_key" ON "User"("idNumber");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- CreateIndex
CREATE INDEX "Otp_cellNumber_purpose_idx" ON "Otp"("cellNumber", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Application_reference_key" ON "Application"("reference");

-- CreateIndex
CREATE INDEX "Application_status_idx" ON "Application"("status");

-- CreateIndex
CREATE INDEX "Application_userId_idx" ON "Application"("userId");

-- CreateIndex
CREATE INDEX "Application_idNumber_idx" ON "Application"("idNumber");

-- CreateIndex
CREATE INDEX "Application_capturedById_idx" ON "Application"("capturedById");

-- CreateIndex
CREATE INDEX "Application_captureChannel_idx" ON "Application"("captureChannel");

-- CreateIndex
CREATE INDEX "Application_verificationStage_idx" ON "Application"("verificationStage");

-- CreateIndex
CREATE INDEX "Application_approvalStage_idx" ON "Application"("approvalStage");

-- CreateIndex
CREATE INDEX "Application_hasDisability_idx" ON "Application"("hasDisability");

-- CreateIndex
CREATE INDEX "Application_age_idx" ON "Application"("age");

-- CreateIndex
CREATE INDEX "Application_anonymisedAt_idx" ON "Application"("anonymisedAt");

-- CreateIndex
CREATE INDEX "Application_status_reviewedAt_idx" ON "Application"("status", "reviewedAt");

-- CreateIndex
CREATE INDEX "Application_expiresAt_idx" ON "Application"("expiresAt");

-- CreateIndex
CREATE INDEX "Application_renewalStatus_idx" ON "Application"("renewalStatus");

-- CreateIndex
CREATE INDEX "Application_wardNumber_idx" ON "Application"("wardNumber");

-- CreateIndex
CREATE INDEX "Application_status_submittedAt_idx" ON "Application"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "Application_reference_idx" ON "Application"("reference");

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
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userEmail_idx" ON "AuditLog"("userEmail");

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
CREATE INDEX "SmsMessage_toNumber_idx" ON "SmsMessage"("toNumber");

-- CreateIndex
CREATE INDEX "SmsMessage_createdAt_idx" ON "SmsMessage"("createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_status_idx" ON "SmsMessage"("status");

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
CREATE INDEX "Document_applicationId_idx" ON "Document"("applicationId");

-- AddForeignKey
ALTER TABLE "Otp" ADD CONSTRAINT "Otp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_capturedById_fkey" FOREIGN KEY ("capturedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationCheck" ADD CONSTRAINT "VerificationCheck_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldChange" ADD CONSTRAINT "FieldChange_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Beyond the schema: what Prisma cannot express
-- ===========================================================================
--
-- The audit trail is append-only, enforced by the database rather than by the
-- application. An application-level check protects against application bugs;
-- this protects against everything else, including somebody at a psql prompt.
--
-- Exactly one exception is permitted: DELETE inside a retention sweep, because
-- POPIA s14 obliges the municipality to remove personal information once the
-- purpose it was collected for has expired, and an application cascades into
-- these tables. The flag is transaction-local so it cannot be left switched on,
-- and UPDATE and TRUNCATE stay refused whatever is set.
--
-- See src/lib/retention.js, and scripts/verify-audit-immutability.js which
-- proves all of this against a real database.

CREATE OR REPLACE FUNCTION public.refuse_audit_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Statement-level TRUNCATE has no OLD/NEW row to return, and is never
  -- legitimate here regardless, so it is checked first and always refused.
  IF TG_OP = 'DELETE' AND current_setting('indigent.retention_sweep', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'Table % is append-only: % is not permitted. This is the audit trail; correct the record by adding to it, not by changing it.',
    TG_TABLE_NAME, TG_OP
    USING
      ERRCODE = 'restrict_violation',
      HINT = 'Records expire through the retention policy, which removes whole expired records inside an audited sweep. Nothing rewrites an audit row.';
END;
$function$
;

CREATE TRIGGER approval_step_no_delete BEFORE DELETE ON public."ApprovalStep" FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER approval_step_no_truncate BEFORE TRUNCATE ON public."ApprovalStep" FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON public."AuditLog" FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public."AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON public."AuditLog" FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER field_change_no_delete BEFORE DELETE ON public."FieldChange" FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER field_change_no_truncate BEFORE TRUNCATE ON public."FieldChange" FOR EACH STATEMENT EXECUTE FUNCTION refuse_audit_mutation();
CREATE TRIGGER field_change_no_update BEFORE UPDATE ON public."FieldChange" FOR EACH ROW EXECUTE FUNCTION refuse_audit_mutation();

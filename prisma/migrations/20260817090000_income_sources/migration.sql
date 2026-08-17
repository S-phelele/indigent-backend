-- Where a household's money comes from, as rows rather than five columns.
--
-- The five columns on Application could hold five kinds of income and no more,
-- so a household with two grants, or a pension and a lodger, had nowhere to
-- record the second. They are left in place by this migration and stop being
-- written; a later one drops them, once the backfill below has been confirmed
-- against real data. Dropping them here would leave no way back.

-- CreateEnum
CREATE TYPE "IncomeSourceType" AS ENUM ('SALARY', 'SELF_EMPLOYMENT', 'BUSINESS', 'CHILD_GRANT', 'OLD_AGE_PENSION', 'DISABILITY_GRANT', 'FOSTER_CARE_GRANT', 'CARE_DEPENDENCY_GRANT', 'RETIREMENT_FUND', 'UIF', 'RENTAL', 'MAINTENANCE', 'REMITTANCE', 'OTHER');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "declaredNoIncome" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "IncomeSource" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" "IncomeSourceType" NOT NULL,
    "monthlyAmount" DECIMAL(12,2) NOT NULL,
    "jobDescription" TEXT,
    "employerName" TEXT,
    "businessName" TEXT,
    "businessType" TEXT,
    "isRegistered" BOOLEAN,
    "otherDetail" TEXT,
    "memberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncomeSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncomeSource_applicationId_idx" ON "IncomeSource"("applicationId");

-- AddForeignKey
ALTER TABLE "IncomeSource" ADD CONSTRAINT "IncomeSource_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill
--
-- One row per column that held an amount. Only amounts above zero become rows:
-- a zero in the old schema could mean "none" or "never asked" and there is no
-- way to tell which, so inventing a row asserting one of them would be worse
-- than leaving the household to be asked again.
--
-- declaredNoIncome is deliberately not inferred for the same reason. An
-- application whose columns were all zero is not evidence that anybody said so.
--
-- Employer name is carried across onto the salary row, since that is where it
-- belongs now. The Application column keeps its copy until the drop migration.
-- ---------------------------------------------------------------------------

INSERT INTO "IncomeSource" ("id", "applicationId", "type", "monthlyAmount", "employerName", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'SALARY', "salary", "employerName", NOW(), NOW()
FROM "Application" WHERE "salary" IS NOT NULL AND "salary" > 0;

INSERT INTO "IncomeSource" ("id", "applicationId", "type", "monthlyAmount", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'OLD_AGE_PENSION', "oldAgePension", NOW(), NOW()
FROM "Application" WHERE "oldAgePension" IS NOT NULL AND "oldAgePension" > 0;

-- The old column was called disabilityPension; SASSA pays a disability *grant*,
-- and the register should use the payer's word for it.
INSERT INTO "IncomeSource" ("id", "applicationId", "type", "monthlyAmount", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'DISABILITY_GRANT', "disabilityPension", NOW(), NOW()
FROM "Application" WHERE "disabilityPension" IS NOT NULL AND "disabilityPension" > 0;

INSERT INTO "IncomeSource" ("id", "applicationId", "type", "monthlyAmount", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'BUSINESS', "businessIncome", NOW(), NOW()
FROM "Application" WHERE "businessIncome" IS NOT NULL AND "businessIncome" > 0;

INSERT INTO "IncomeSource" ("id", "applicationId", "type", "monthlyAmount", "createdAt", "updatedAt")
SELECT gen_random_uuid(), "id", 'RENTAL', "rentingIncome", NOW(), NOW()
FROM "Application" WHERE "rentingIncome" IS NOT NULL AND "rentingIncome" > 0;

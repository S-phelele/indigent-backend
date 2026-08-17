-- When the cell number was verified, and which number it was.
--
-- The account keeps the live truth in User.cellVerifiedAt. The two columns on
-- Application are copied from it at submission and never change afterwards,
-- for the same reason incomeThresholdApplied is frozen there: an applicant who
-- changes their number later must not retroactively turn an already-decided
-- application into one that reads "not verified".

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "cellVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "cellVerifiedNumber" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cellVerifiedAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Accounts already flagged verified were verified at some point nobody
-- recorded. updatedAt is the closest honest approximation available and is
-- used rather than NOW(), which would claim every historic verification
-- happened during this migration.
--
-- Applications already carrying cellVerified = true get the number from their
-- own record. No date is invented for them: a null here reads as "verified,
-- date not known", which is true, where a fabricated timestamp would not be.
-- ---------------------------------------------------------------------------

UPDATE "User"
SET "cellVerifiedAt" = "updatedAt"
WHERE "isVerified" = true AND "cellVerifiedAt" IS NULL;

UPDATE "Application"
SET "cellVerifiedNumber" = "cellNumber"
WHERE "cellVerified" = true AND "cellNumber" IS NOT NULL AND "cellVerifiedNumber" IS NULL;

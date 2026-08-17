-- Every given name, as the applicant writes them.
--
-- `names` was one field people filled in inconsistently — sometimes a first
-- name, sometimes all of them, sometimes the whole name including the surname.
-- Somebody with three given names has a right to have all three recorded, and a
-- letter addressed to the wrong one is a small insult that is avoidable.
--
-- `names` is left in place and backfilled from, not dropped. A later migration
-- removes it once this has been confirmed against real data; doing both at once
-- would leave no way back if the backfill were wrong.
--
-- Initials are deliberately NOT a column. They are derived on read in
-- src/lib/names.js, because two fields holding the same fact are two fields
-- that can disagree, and the one nobody looks at is the one that goes stale.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "fullName" TEXT;

-- Backfill: whatever was in `names` is at least the applicant's own words for
-- their given names, which is a better starting point than empty.
UPDATE "Application"
SET "fullName" = "names"
WHERE "names" IS NOT NULL AND btrim("names") <> '' AND "fullName" IS NULL;

-- Bring existing applications onto the new document rules.
--
-- Separate from the migration that added PROOF_OF_INCOME because PostgreSQL
-- refuses to *use* an enum value inside the same transaction that adds it
-- ("unsafe use of new value of enum type"). Splitting them is the supported fix.
--
-- The rule change: bank statements are no longer required, and proof of income
-- OR proof of grant now is. Roughly a fifth of South African adults have no bank
-- account, so demanding statements excluded exactly the households this register
-- exists for.
--
-- ## Only drafts are touched
--
-- Applications that have already been submitted keep the obligations they were
-- assessed under. Retro-fitting a new requirement onto a decided application
-- would make the record read as though evidence was missing when the decision
-- was taken — the same reason incomeThresholdApplied is frozen at submission.
--
-- Because src/lib/documentSlots.js skips a requirement group that has no slots
-- on an application, historic records simply carry no group and stay complete.

-- 1. Bank statements become optional supporting evidence on unsubmitted work.
UPDATE "Document" d
SET "importance" = 'OPTIONAL'
FROM "Application" a
WHERE d."applicationId" = a."id"
  AND a."status" = 'DRAFT'
  AND d."type" = 'BANK_STATEMENTS';

-- 2. Proof of grant joins the financial-evidence group.
UPDATE "Document" d
SET "requirementGroup" = 'financial_evidence',
    "importance" = 'OPTIONAL'
FROM "Application" a
WHERE d."applicationId" = a."id"
  AND a."status" = 'DRAFT'
  AND d."type" = 'PROOF_OF_GRANT';

-- 3. Every draft gains a proof-of-income slot, unless it somehow has one.
INSERT INTO "Document" ("id", "applicationId", "name", "type", "importance", "requirementGroup", "status", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  a."id",
  'Proof of Income',
  'PROOF_OF_INCOME',
  'OPTIONAL',
  'financial_evidence',
  'Pending',
  NOW(),
  NOW()
FROM "Application" a
WHERE a."status" = 'DRAFT'
  AND NOT EXISTS (
    SELECT 1 FROM "Document" d
    WHERE d."applicationId" = a."id" AND d."type" = 'PROOF_OF_INCOME'
  );

-- 4. Existing accounts were all self-registered or created at the office; the
--    captureChannel column already defaults to 'SELF', so nothing to backfill.

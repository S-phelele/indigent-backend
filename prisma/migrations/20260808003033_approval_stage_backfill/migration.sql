-- Place existing applications correctly in the new approval chain.
--
-- The column defaults to NOT_SUBMITTED, which is right for a new record and
-- wrong for every application that already exists. Without this, applications
-- already awaiting review would be invisible to the verification queue — the
-- worst possible failure, because nothing would look broken.

-- 1. Anything already submitted and undecided starts at the front of the chain.
UPDATE "Application"
SET "approvalStage" = 'VERIFICATION'
WHERE "status" = 'PENDING';

-- 2. Anything already decided has been through it, however informally.
UPDATE "Application"
SET "approvalStage" = 'COMPLETE'
WHERE "status" IN ('APPROVED', 'DECLINED');

-- 3. Drafts stay where they are; NOT_SUBMITTED is correct for them.

-- 4. Give existing approvals a renewal cycle.
--
--    They were approved before expiry dates existed, so the twelve months runs
--    from when they were reviewed. Where that is unknown, from when they were
--    created — an approval with no date is worse than one dated conservatively,
--    because it would never come up for re-verification at all.
UPDATE "Application"
SET "approvedAt"    = COALESCE("reviewedAt", "submittedAt", "createdAt"),
    "expiresAt"     = COALESCE("reviewedAt", "submittedAt", "createdAt") + INTERVAL '12 months',
    "renewalStatus" = 'ACTIVE'
WHERE "status" = 'APPROVED'
  AND "expiresAt" IS NULL;

-- 5. Mark any whose twelve months has already passed, so the sweep does not
--    announce a batch of "expiring soon" for registrations that expired long ago.
UPDATE "Application"
SET "renewalStatus" = 'LAPSED'
WHERE "status" = 'APPROVED'
  AND "expiresAt" IS NOT NULL
  AND "expiresAt" < NOW() - INTERVAL '30 days';

UPDATE "Application"
SET "renewalStatus" = 'OVERDUE'
WHERE "status" = 'APPROVED'
  AND "expiresAt" IS NOT NULL
  AND "expiresAt" < NOW()
  AND "expiresAt" >= NOW() - INTERVAL '30 days';

-- The superuser role, and the record its exemption leaves behind.
--
-- SUPERUSER is exempt from separation of duties: one account can take a case
-- from capture through to a signed approval on its own. That removes the
-- control the approval chain exists to provide, so the two columns below are
-- what remains of it — every stage taken on a case the actor had already worked
-- is marked, with the reason in words.
--
-- Existing rows are not overrides. The default is correct for all of them:
-- before this migration the exemption existed for ADMIN but was never recorded,
-- so there is no historic data to backfill and nothing to infer.

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUPERUSER';

-- AlterTable
ALTER TABLE "ApprovalStep" ADD COLUMN     "isOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "overrideReason" TEXT;

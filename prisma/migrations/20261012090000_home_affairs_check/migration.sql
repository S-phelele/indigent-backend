-- AlterEnum
ALTER TYPE "CheckSource" ADD VALUE 'HOME_AFFAIRS';

-- AlterTable
ALTER TABLE "VerificationCheck" ADD COLUMN     "automated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "creditsUsed" INTEGER;

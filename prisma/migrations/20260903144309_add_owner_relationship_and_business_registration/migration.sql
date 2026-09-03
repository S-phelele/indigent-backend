-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "ownerDeceased" BOOLEAN,
ADD COLUMN     "ownerRelationship" TEXT;

-- AlterTable
ALTER TABLE "IncomeSource" ADD COLUMN     "registrationNumber" TEXT;

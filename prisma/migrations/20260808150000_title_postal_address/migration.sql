-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "postalCity" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "postalLine1" TEXT,
ADD COLUMN     "postalLine2" TEXT,
ADD COLUMN     "postalSameAsResidential" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "postalSuburb" TEXT,
ADD COLUMN     "title" TEXT;


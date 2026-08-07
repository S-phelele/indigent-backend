-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "addressAccuracyM" INTEGER,
ADD COLUMN     "addressFormatted" TEXT,
ADD COLUMN     "addressLatitude" DECIMAL(10,7),
ADD COLUMN     "addressLongitude" DECIMAL(10,7),
ADD COLUMN     "addressSource" TEXT,
ADD COLUMN     "addressVerifiedAt" TIMESTAMP(3);

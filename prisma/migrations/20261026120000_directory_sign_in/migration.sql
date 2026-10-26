-- CreateEnum
CREATE TYPE "AuthSource" AS ENUM ('LOCAL', 'DIRECTORY');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "authSource" "AuthSource" NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "directoryUsername" TEXT,
ADD COLUMN     "directorySyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");

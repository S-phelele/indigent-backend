-- CreateEnum
CREATE TYPE "DifficultyLevel" AS ENUM ('NO_DIFFICULTY', 'SOME_DIFFICULTY', 'A_LOT_OF_DIFFICULTY', 'CANNOT_DO_AT_ALL');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('FEMALE', 'MALE');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "age" INTEGER,
ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "difficultyCommunicating" "DifficultyLevel",
ADD COLUMN     "difficultyHearing" "DifficultyLevel",
ADD COLUMN     "difficultyRemembering" "DifficultyLevel",
ADD COLUMN     "difficultySeeing" "DifficultyLevel",
ADD COLUMN     "difficultySelfCare" "DifficultyLevel",
ADD COLUMN     "difficultyWalking" "DifficultyLevel",
ADD COLUMN     "hasDisability" BOOLEAN,
ADD COLUMN     "sex" "Sex";

-- CreateIndex
CREATE INDEX "Application_hasDisability_idx" ON "Application"("hasDisability");

-- CreateIndex
CREATE INDEX "Application_age_idx" ON "Application"("age");


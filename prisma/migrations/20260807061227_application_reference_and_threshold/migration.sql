-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "incomeThresholdApplied" DECIMAL(12,2),
ADD COLUMN     "reference" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Application_reference_key" ON "Application"("reference");

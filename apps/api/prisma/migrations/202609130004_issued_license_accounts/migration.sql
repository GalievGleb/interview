ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'MANUAL';
CREATE TABLE "IssuedLicense" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "plan" "Plan" NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IssuedLicense_email_idx" ON "IssuedLicense"("email");

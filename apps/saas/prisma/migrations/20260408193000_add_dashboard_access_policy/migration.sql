-- CreateTable
CREATE TABLE "DashboardAccessPolicy" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'admin',
  "sites" TEXT[] DEFAULT ARRAY['*']::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DashboardAccessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DashboardAccessPolicy_email_key" ON "DashboardAccessPolicy"("email");

-- CreateIndex
CREATE INDEX "DashboardAccessPolicy_status_idx" ON "DashboardAccessPolicy"("status");

-- CreateIndex
CREATE INDEX "DashboardAccessPolicy_role_idx" ON "DashboardAccessPolicy"("role");

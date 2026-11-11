-- CreateEnum
CREATE TYPE "platform" AS ENUM ('facebook', 'instagram', 'threads', 'youtube', 'linkedin', 'tiktok');

-- CreateEnum
CREATE TYPE "publication_state" AS ENUM ('draft', 'pending_approval', 'scheduled', 'queued', 'publishing', 'uploading', 'remote_processing', 'published', 'retrying', 'failed', 'needs_action', 'unknown_outcome', 'reconciled', 'cancelled');

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform" "platform" NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_targets" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "state" "publication_state" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMPTZ(6),
    "queued_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_organization_id_id_key" ON "social_accounts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_organization_id_platform_external_account_i_key" ON "social_accounts"("organization_id", "platform", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "publication_targets_organization_id_id_key" ON "publication_targets"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "publication_targets_post_id_social_account_id_key" ON "publication_targets"("post_id", "social_account_id");

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_organization_id_workspace_id_fkey" FOREIGN KEY ("organization_id", "workspace_id") REFERENCES "workspaces"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_targets" ADD CONSTRAINT "publication_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_targets" ADD CONSTRAINT "publication_targets_organization_id_post_id_fkey" FOREIGN KEY ("organization_id", "post_id") REFERENCES "posts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_targets" ADD CONSTRAINT "publication_targets_organization_id_social_account_id_fkey" FOREIGN KEY ("organization_id", "social_account_id") REFERENCES "social_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "error_class" AS ENUM ('transient', 'quota', 'auth', 'content', 'unknown');

-- AlterTable
ALTER TABLE "publication_targets" ADD COLUMN     "publishing_started_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "publication_state",
    "error_class" "error_class",
    "request" JSONB,
    "response" JSONB,

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_organization_id_id_key" ON "publish_attempts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_target_id_attempt_no_key" ON "publish_attempts"("target_id", "attempt_no");

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_organization_id_target_id_fkey" FOREIGN KEY ("organization_id", "target_id") REFERENCES "publication_targets"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

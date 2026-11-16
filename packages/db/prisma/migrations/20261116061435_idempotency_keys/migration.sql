-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organization_id_id_key" ON "idempotency_keys"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_organization_id_key_key" ON "idempotency_keys"("organization_id", "key");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "organization_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sealed_private_key" BYTEA NOT NULL,
    "master_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_credentials" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "organization_key_id" UUID NOT NULL,
    "sealed_tokens" BYTEA NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_keys_organization_id_key" ON "organization_keys"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_keys_organization_id_id_key" ON "organization_keys"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credentials_social_account_id_key" ON "oauth_credentials"("social_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credentials_organization_id_id_key" ON "oauth_credentials"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_credentials_organization_id_social_account_id_key" ON "oauth_credentials"("organization_id", "social_account_id");

-- AddForeignKey
ALTER TABLE "organization_keys" ADD CONSTRAINT "organization_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_organization_id_social_account_id_fkey" FOREIGN KEY ("organization_id", "social_account_id") REFERENCES "social_accounts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_organization_id_organization_key_id_fkey" FOREIGN KEY ("organization_id", "organization_key_id") REFERENCES "organization_keys"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

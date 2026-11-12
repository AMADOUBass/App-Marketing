-- Token vault tables (ADR 006): standard tenant isolation. Their content is already sealed; RLS keeps
-- even the sealed blobs of one organization out of another organization's reach.
ALTER TABLE "organization_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organization_keys"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

ALTER TABLE "oauth_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "oauth_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "oauth_credentials"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

-- Keys are created once and never edited in place (rotation = new sealed copy, see ADR 006).
REVOKE UPDATE ON TABLE "organization_keys" FROM app_user;

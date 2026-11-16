-- Idempotency keys (ADR 012): standard tenant isolation. A key of one organization is invisible to
-- another one, so the same client-generated key used by two organizations never collides in effect.
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idempotency_keys"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

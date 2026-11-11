-- Row-level security for every business table (CLAUDE.md rule 4).
-- Rows are visible only to the organization set by withTenant() with set_config('app.org_id', ..., true).
-- current_setting() is called without missing_ok on purpose: a query without tenant context fails
-- instead of returning rows. FORCE applies the policies to the table owner too.
-- New business tables must get the same block (test/rls-coverage.test.ts enforces it).

-- organizations: the tenant is the row itself.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organizations"
  USING ("id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("id" = current_setting('app.org_id')::uuid);

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workspaces"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "memberships"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "posts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "posts"
  USING ("organization_id" = current_setting('app.org_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id')::uuid);

-- The runtime role has no business reading or editing the migration history.
-- Conditional: Prisma's shadow database replays migrations without a _prisma_migrations table.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    REVOKE ALL ON TABLE "_prisma_migrations" FROM app_user;
  END IF;
END
$$;

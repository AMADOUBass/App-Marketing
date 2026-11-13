-- Identity access rules (ADR 008).
--
-- 1. Schema "auth" (Better Auth: users, sessions, accounts, verifications) is reachable ONLY by app_auth.
--    app_user (API business code, worker) cannot even see it. app_auth gets nothing in schema public.
REVOKE ALL ON SCHEMA "auth" FROM PUBLIC;
GRANT USAGE ON SCHEMA "auth" TO app_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "auth" TO app_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA "auth"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_auth;

-- 2. "Which organizations is this user a member of?" is the only question that crosses organizations on
--    memberships. It is answered by one SECURITY DEFINER function owned by the NOLOGIN role app_directory,
--    which may read 3 columns of memberships and 2 of organizations, nothing else.
--    tenant_isolation on these two tables now targets app_user only, so the function never evaluates
--    current_setting('app.org_id') (same pattern as publication_targets, ADR 005).
ALTER POLICY tenant_isolation ON "memberships" TO app_user;
ALTER POLICY tenant_isolation ON "organizations" TO app_user;

GRANT USAGE, CREATE ON SCHEMA public TO app_directory;
GRANT SELECT ("organization_id", "user_id", "role") ON "memberships" TO app_directory;
GRANT SELECT ("id", "name") ON "organizations" TO app_directory;
CREATE POLICY directory_read ON "memberships" FOR SELECT TO app_directory USING (true);
CREATE POLICY directory_read ON "organizations" FOR SELECT TO app_directory USING (true);

CREATE FUNCTION list_user_organizations(p_user_id uuid)
RETURNS TABLE (organization_id uuid, name text, role organization_role)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.id, o.name, m.role
  FROM public.memberships m
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = p_user_id
  ORDER BY o.name
$$;

ALTER FUNCTION list_user_organizations(uuid) OWNER TO app_directory;
REVOKE ALL ON FUNCTION list_user_organizations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_user_organizations(uuid) TO app_user;

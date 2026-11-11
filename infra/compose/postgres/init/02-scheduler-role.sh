#!/bin/sh
# Runs on first start of an empty data volume, after 01-roles.sh. Idempotent: safe to run again on an
# existing database (see docs/adr/005):
#   docker exec -i -e APP_DB_NAME=app app-dev-postgres-1 sh < infra/compose/postgres/init/02-scheduler-role.sh
#
# app_scheduler  NOLOGIN. Owns the SECURITY DEFINER functions that hand due publication targets to the
#                queue: the only code path allowed to touch publication_targets across organizations.
#                Nobody can log in as it. app_migrator is a member only so migrations can make it the
#                owner of those functions (the schema grants live in the migration itself).
# app_migrator   gets BYPASSRLS (also set in 01-roles.sh for new volumes): adding a foreign key makes
#                PostgreSQL validate it by reading the referenced table, which forced RLS would block.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-postgres}" --dbname "$APP_DB_NAME" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_scheduler') THEN
    CREATE ROLE app_scheduler NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
  END IF;
END
$$;

ALTER ROLE app_migrator BYPASSRLS;
GRANT app_scheduler TO app_migrator;
SQL

#!/bin/sh
# Runs on first start of an empty data volume, after 02. Idempotent: safe to run again on an existing
# database (see docs/adr/008):
#   docker exec -i -e APP_DB_NAME=app -e APP_AUTH_PASSWORD=app_auth_dev app-dev-postgres-1 \
#     sh < infra/compose/postgres/init/03-identity-roles.sh
#
# app_auth       LOGIN. Used only by Better Auth in the API. Reaches the "auth" schema (users, sessions,
#                accounts, verifications) and nothing else: no access to business tables.
# app_directory  NOLOGIN. Owns the SECURITY DEFINER function listing the organizations of one user (the
#                only cross-organization read of memberships). app_migrator is a member only so
#                migrations can make it the owner of that function.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER:-postgres}" --dbname "$APP_DB_NAME" \
  -v db_name="$APP_DB_NAME" \
  -v auth_password="${APP_AUTH_PASSWORD:-app_auth_dev}" <<'SQL'
SELECT format('CREATE ROLE app_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT PASSWORD %L', :'auth_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth')
\gexec
ALTER ROLE app_auth PASSWORD :'auth_password';
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO app_auth;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_directory') THEN
    CREATE ROLE app_directory NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT;
  END IF;
END
$$;
GRANT app_directory TO app_migrator;
SQL

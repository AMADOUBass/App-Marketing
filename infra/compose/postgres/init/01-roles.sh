#!/bin/sh
# Runs once, on first start of an empty data volume.
#
# Roles:
#   app_migrator  owns the database and schema; runs Prisma Migrate and the SQL migrations (RLS).
#                 CREATEDB is needed for Prisma's shadow database in development.
#   app_user      role used by api and worker at runtime. NOT superuser, NOT owner, NO BYPASSRLS:
#                 row-level security always applies to it.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname postgres \
  -v db_name="$APP_DB_NAME" \
  -v migrator_password="$APP_MIGRATOR_PASSWORD" \
  -v app_password="$APP_USER_PASSWORD" <<'SQL'
CREATE ROLE app_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE CREATEDB
  PASSWORD :'migrator_password';
CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT
  PASSWORD :'app_password';

CREATE DATABASE :"db_name" OWNER app_migrator;
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO app_user;

\connect :"db_name"

ALTER SCHEMA public OWNER TO app_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user;

-- Every table and sequence that app_migrator creates later is usable (not alterable) by app_user.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
SQL

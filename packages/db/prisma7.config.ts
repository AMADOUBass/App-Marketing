import { defineConfig } from 'prisma/config';

// Prisma CLI only (migrate, generate). The app connects at runtime with DATABASE_URL (app_user role).
// Migrations run as the schema owner (app_migrator), never as app_user.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment (CI).
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // A placeholder keeps `prisma generate` working without a database (it never connects).
    url: process.env.MIGRATION_DATABASE_URL ?? 'postgresql://unset@127.0.0.1:5432/unset',
  },
});

// Identity database access for Better Auth (ADR 008), imported from '@ponctua/db/identity' by the API only.
// Unlike createDb(), this returns a raw Prisma client: it must be connected as app_auth, a role that can
// reach the "auth" schema (users, sessions, accounts, verifications) and NOTHING in schema public.
// The database enforces that limit, not this code.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export type IdentityClient = PrismaClient;

export function createIdentityClient(connectionString: string): IdentityClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

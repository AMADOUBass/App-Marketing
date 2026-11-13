// Local development only (`pnpm db:seed`): a demo user who owns the demo organizations, so the web
// sign-in works right after seeding. Created through Better Auth (password hashed like a real sign-up).
// Extra organizations to join: `pnpm db:seed -- --org <id>` (e.g. one created before ADR 008).
// Idempotent. Refuses to run with NODE_ENV=production.
import { createDb } from '@ponctua/db';
import { DEMO_ORGANIZATIONS, DEMO_USER } from '@ponctua/db/demo';
import { createIdentityClient } from '@ponctua/db/identity';
import { z } from 'zod';
import { parseEnv } from '../config/env.js';
import { createAuth } from '../modules/identity/auth.js';

function extraOrganizations(argv: string[]): string[] {
  const ids: string[] = [];
  argv.forEach((arg, index) => {
    if (arg === '--org') ids.push(z.uuid().parse(argv[index + 1]));
  });
  return ids;
}

const env = parseEnv(process.env);
if (env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to create the demo user with NODE_ENV=production\n');
  process.exit(1);
}

const identity = createIdentityClient(env.AUTH_DATABASE_URL);
const db = createDb({ connectionString: env.DATABASE_URL });
try {
  let user = await identity.user.findUnique({ where: { email: DEMO_USER.email } });
  if (!user) {
    await createAuth(env, identity).api.signUpEmail({ body: { ...DEMO_USER } });
    user = await identity.user.findUniqueOrThrow({ where: { email: DEMO_USER.email } });
  }
  const userId = user.id;

  const joined: string[] = [];
  const organizationIds = [
    ...DEMO_ORGANIZATIONS.map((organization) => organization.id),
    ...extraOrganizations(process.argv.slice(2)),
  ];
  for (const organizationId of organizationIds) {
    const name = await db.withTenant(organizationId, async (tx) => {
      const organization = await tx.organization.findFirst({ select: { name: true } });
      if (!organization) return null;
      if (!(await tx.membership.findFirst({ where: { userId } }))) {
        await tx.membership.create({ data: { organizationId, userId, role: 'owner' } });
      }
      return organization.name;
    });
    if (name) joined.push(`  ${organizationId}  ${name}`);
    else process.stderr.write(`Organization ${organizationId} not found: skipped\n`);
  }

  process.stdout.write(
    [
      '',
      'Demo user (local only) — sign in at http://localhost:5173/login',
      `  email:    ${DEMO_USER.email}`,
      `  password: ${DEMO_USER.password}`,
      'Owner of:',
      ...joined,
      '',
    ].join('\n'),
  );
} finally {
  await identity.$disconnect();
  await db.disconnect();
}

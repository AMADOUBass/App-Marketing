// Demo data for local development: `pnpm db:seed` (runs as app_user, through withTenant like the app).
// Idempotent: fixed ids, existing rows are kept. Never run against production.
import { createDb } from './tenant.js';

const DEMO = [
  {
    id: '0195f000-0000-7000-8000-00000000000a',
    name: 'Agence Démo A',
    workspaceId: '0195f000-0000-7000-8000-0000000000a1',
    workspaceName: 'Boulangerie du Plateau',
    posts: [
      'Nouveau croissant aux amandes dès samedi 🥐',
      'Horaires des fêtes : ouvert le 24 jusqu’à 16 h.',
      'Merci à nos 10 000 abonnés ! Concours en story cette semaine.',
    ],
  },
  {
    id: '0195f000-0000-7000-8000-00000000000b',
    name: 'Agence Démo B',
    workspaceId: '0195f000-0000-7000-8000-0000000000b1',
    workspaceName: 'Café Laurier',
    posts: ['Our winter menu is here: maple latte is back.'],
  },
];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write(
    'DATABASE_URL is required (app_user connection, see packages/db/.env.example)\n',
  );
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data with NODE_ENV=production\n');
  process.exit(1);
}

const db = createDb({ connectionString });
try {
  for (const org of DEMO) {
    await db.withTenant(org.id, async (tx) => {
      await tx.organization.upsert({
        where: { id: org.id },
        create: { id: org.id, name: org.name },
        update: {},
      });
      await tx.workspace.upsert({
        where: { id: org.workspaceId },
        create: { id: org.workspaceId, organizationId: org.id, name: org.workspaceName },
        update: {},
      });
      if ((await tx.post.count()) === 0) {
        for (const body of org.posts) {
          await tx.post.create({
            data: { organizationId: org.id, workspaceId: org.workspaceId, body },
          });
        }
      }
    });
  }

  process.stdout.write('Demo organizations (use an id on the web sign-in page):\n');
  for (const org of DEMO) process.stdout.write(`  ${org.id}  ${org.name}\n`);
} finally {
  await db.disconnect();
}

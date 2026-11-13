// `pnpm dev:test-post --org <id> --image <https url> [--caption "..."] [--in 60]`
// Local development only: creates a post with an image and schedules it on the organization's connected
// Instagram account, so the real scheduler + worker publish it. Runs as app_user through withTenant.
import { parseArgs } from 'node:util';
import { createDb } from './tenant.js';

const { values } = parseArgs({
  // pnpm forwards a literal "--" when the command already has one: ignore it.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    org: { type: 'string' },
    image: { type: 'string' },
    caption: { type: 'string', default: 'Test de publication depuis App Marketing 🚀' },
    in: { type: 'string', default: '60' },
  },
});

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production')
  fail('Refusing to create test posts with NODE_ENV=production');
const connectionString =
  process.env.DATABASE_URL ?? fail('DATABASE_URL is required (see packages/db/.env.example)');
const organizationId = values.org ?? fail('--org <organization id> is required');
const imageUrl = values.image ?? fail('--image <public https url of a JPEG> is required');
if (!imageUrl.startsWith('https://'))
  fail('--image must be a public HTTPS URL (Instagram downloads it)');
const delaySeconds = Number(values.in);
if (!Number.isInteger(delaySeconds) || delaySeconds < 0) fail('--in must be a number of seconds');

const db = createDb({ connectionString });
try {
  const result = await db.withTenant(organizationId, async (tx) => {
    const account = await tx.socialAccount.findFirst({
      where: { platform: 'instagram', credential: { isNot: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!account) return null;
    const post = await tx.post.create({
      data: {
        organizationId,
        workspaceId: account.workspaceId,
        body: values.caption,
        imageUrl,
      },
    });
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000);
    const target = await tx.publicationTarget.create({
      data: {
        organizationId,
        postId: post.id,
        socialAccountId: account.id,
        state: 'scheduled',
        scheduledAt,
      },
    });
    return { account: account.displayName, targetId: target.id, scheduledAt };
  });

  if (!result)
    fail(
      'No connected Instagram account in this organization: connect one from the web app first.',
    );
  process.stdout.write(
    `Scheduled on @${result.account} at ${result.scheduledAt.toISOString()} (target ${result.targetId}).\n` +
      'Keep `pnpm dev` running: the worker publishes it, then the target state shows the outcome.\n',
  );
} finally {
  await db.disconnect();
}

import type { Db } from '@app/db';
import type { PlatformAdapter, PublishOutcome } from '@app/integrations';
import type { VaultOpener } from '@app/vault/open';
import type {
  PublishHandler,
  PublishHooks,
  PublishResult,
  PublishTarget,
} from './publish-handler.js';

/** Phase 0: the media library does not exist yet, so the type comes from the URL extension. */
function mimeTypeOf(url: string): string {
  const path = new URL(url).pathname.toLowerCase();
  return path.endsWith('.jpg') || path.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'application/octet-stream';
}

/** Adapter outcome -> target state. Retries come with the publishing engine; nothing stays in flight. */
export function toPublishResult(outcome: PublishOutcome): PublishResult {
  switch (outcome.status) {
    case 'published':
      return {
        state: 'published',
        response: { containerId: outcome.containerId, remoteMediaId: outcome.remoteMediaId },
      };
    case 'unknown_outcome':
      return {
        state: 'unknown_outcome',
        errorClass: 'unknown',
        response: { containerId: outcome.containerId },
      };
    case 'failed':
      return {
        // A token or account problem needs the client (reconnect, restriction); the rest is a final failure.
        state: outcome.errorClass === 'auth' ? 'needs_action' : 'failed',
        errorClass: outcome.errorClass,
        response: { containerId: outcome.containerId, detail: outcome.detail },
      };
  }
}

/**
 * Publishes one target on Instagram. Reads the post, the account and the sealed token inside withTenant,
 * then calls the platform OUTSIDE the transaction (no database lock held during network calls).
 * The token is opened here, in the worker, and only exists as a Secret (ADR 006).
 */
export class InstagramPublishHandler implements PublishHandler {
  constructor(
    private readonly db: Db,
    private readonly opener: VaultOpener,
    private readonly adapter: PlatformAdapter<unknown>,
  ) {}

  async publish(target: PublishTarget, hooks: PublishHooks): Promise<PublishResult> {
    const context = await this.db.withTenant(target.organizationId, async (tx) => ({
      post: await tx.post.findUniqueOrThrow({
        where: { id: target.postId },
        select: { body: true, imageUrl: true },
      }),
      account: await tx.socialAccount.findUniqueOrThrow({
        where: { id: target.socialAccountId },
        select: { externalAccountId: true },
      }),
      credential: await this.opener.loadCredential(tx, {
        organizationId: target.organizationId,
        socialAccountId: target.socialAccountId,
      }),
    }));

    if (!context.credential) {
      return {
        state: 'needs_action',
        errorClass: 'auth',
        response: { reason: 'account not connected' },
      };
    }
    if (!context.post.imageUrl) {
      return { state: 'failed', errorClass: 'content', response: { reason: 'post has no image' } };
    }

    const outcome = await this.adapter.publish(
      {
        remoteAccountId: context.account.externalAccountId,
        accessToken: context.credential.tokens.accessToken,
        variant: {
          caption: context.post.body,
          imageUrl: context.post.imageUrl,
          mimeType: mimeTypeOf(context.post.imageUrl),
        },
      },
      { onContainerCreated: (containerId) => hooks.recordProgress({ containerId }) },
    );
    return toPublishResult(outcome);
  }
}

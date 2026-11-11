import type { Platform } from '@app/db';

export interface PublishTarget {
  organizationId: string;
  targetId: string;
  attemptNo: number;
  postId: string;
  socialAccountId: string;
  platform: Platform;
}

/**
 * Final state chosen by the platform adapter. 'published' means the platform confirmed it (rule 2):
 * an adapter must never return it on assumption.
 */
export type PublishOutcomeState = 'published' | 'needs_action' | 'failed';

export interface PublishHandler {
  publish(target: PublishTarget): Promise<PublishOutcomeState>;
}

export const PUBLISH_HANDLER = Symbol('PUBLISH_HANDLER');

/** Until platform adapters exist (0.9): ask a human to act instead of pretending it was published. */
export class NoAdapterPublishHandler implements PublishHandler {
  publish(): Promise<PublishOutcomeState> {
    return Promise.resolve('needs_action');
  }
}

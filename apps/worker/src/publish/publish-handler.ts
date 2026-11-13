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
export type PublishOutcomeState = 'published' | 'needs_action' | 'failed' | 'unknown_outcome';

export type PublishErrorClass = 'transient' | 'quota' | 'auth' | 'content' | 'unknown';

/** Sanitized platform data kept on the attempt row: ids and codes only, never tokens (rule 3). */
export type AttemptData = Record<string, string | number | boolean | null>;

export interface PublishResult {
  state: PublishOutcomeState;
  errorClass?: PublishErrorClass | null;
  response?: AttemptData;
}

export interface PublishHooks {
  /** Stores progress on the attempt row right away (e.g. the container id, before the risky call). */
  recordProgress(data: AttemptData): Promise<void>;
}

export interface PublishHandler {
  publish(target: PublishTarget, hooks: PublishHooks): Promise<PublishResult>;
}

export const PUBLISH_HANDLER = Symbol('PUBLISH_HANDLER');

/** Until a platform has an adapter: ask a human to act instead of pretending it was published. */
export class NoAdapterPublishHandler implements PublishHandler {
  publish(): Promise<PublishResult> {
    return Promise.resolve({ state: 'needs_action', response: { reason: 'no platform adapter' } });
  }
}

/** Sends each target to its platform's handler; platforms without one fall back to needs_action. */
export class RoutingPublishHandler implements PublishHandler {
  private readonly fallback = new NoAdapterPublishHandler();

  constructor(private readonly handlers: Partial<Record<Platform, PublishHandler>>) {}

  publish(target: PublishTarget, hooks: PublishHooks): Promise<PublishResult> {
    return (this.handlers[target.platform] ?? this.fallback).publish(target, hooks);
  }
}

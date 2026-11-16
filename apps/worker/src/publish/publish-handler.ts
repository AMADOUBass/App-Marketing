import type { Platform } from '@ponctua/db';

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
  /**
   * The platform said nothing was published and the same request may succeed later. The processor
   * turns a retryable transient or quota failure into 'retrying' while attempts remain (ADR 013).
   */
  retryable?: boolean;
  /** Why (a code the web app translates, e.g. "account.reconnect"); never raw platform text. */
  reason?: string;
  response?: AttemptData;
}

/**
 * What the platform says about an unknown outcome (ADR 013). 'not_published' must be certain: a new
 * attempt follows it, so a doubt is 'unknown' (checked again later, then a human decides).
 */
export type ReconcileResult =
  | { outcome: 'published'; response?: AttemptData }
  | {
      outcome: 'not_published';
      errorClass: PublishErrorClass;
      retryable: boolean;
      reason: string;
    }
  | { outcome: 'unknown' };

/**
 * The 15-minute pre-check (CLAUDE.md section 5, ADR 013): what would make the publication fail, found
 * while there is still time to fix it. 'blocked' moves the target to needs_action now; 'warning' keeps
 * it scheduled with a reason (e.g. quota nearly used: the publish will wait and retry); 'unknown' (the
 * platform did not answer) changes nothing.
 */
export type PrecheckResult =
  | { outcome: 'ok' }
  | { outcome: 'blocked'; reason: string }
  | { outcome: 'warning'; reason: string }
  | { outcome: 'unknown' };

export interface PublishHooks {
  /** Stores progress on the attempt row right away (e.g. the container id, before the risky call). */
  recordProgress(data: AttemptData): Promise<void>;
}

export interface PublishHandler {
  publish(target: PublishTarget, hooks: PublishHooks): Promise<PublishResult>;
  /**
   * Asks the platform what became of an attempt whose outcome is unknown. Never publishes.
   * `attempt` is what the attempt row recorded (e.g. the container id), null if nothing was.
   */
  reconcile(target: PublishTarget, attempt: AttemptData | null): Promise<ReconcileResult>;
  /** Checks token, permissions, quota and media before the scheduled time. Never publishes. */
  precheck(target: PublishTarget): Promise<PrecheckResult>;
}

export const PUBLISH_HANDLER = Symbol('PUBLISH_HANDLER');

/** Until a platform has an adapter: ask a human to act instead of pretending it was published. */
export class NoAdapterPublishHandler implements PublishHandler {
  publish(): Promise<PublishResult> {
    return Promise.resolve({
      state: 'needs_action',
      reason: 'platform.unavailable',
      response: { reason: 'no platform adapter' },
    });
  }

  reconcile(): Promise<ReconcileResult> {
    return Promise.resolve({ outcome: 'unknown' });
  }

  precheck(): Promise<PrecheckResult> {
    return Promise.resolve({ outcome: 'blocked', reason: 'platform.unavailable' });
  }
}

/** Sends each target to its platform's handler; platforms without one fall back to needs_action. */
export class RoutingPublishHandler implements PublishHandler {
  private readonly fallback = new NoAdapterPublishHandler();

  constructor(private readonly handlers: Partial<Record<Platform, PublishHandler>>) {}

  publish(target: PublishTarget, hooks: PublishHooks): Promise<PublishResult> {
    return (this.handlers[target.platform] ?? this.fallback).publish(target, hooks);
  }

  reconcile(target: PublishTarget, attempt: AttemptData | null): Promise<ReconcileResult> {
    return (this.handlers[target.platform] ?? this.fallback).reconcile(target, attempt);
  }

  precheck(target: PublishTarget): Promise<PrecheckResult> {
    return (this.handlers[target.platform] ?? this.fallback).precheck(target);
  }
}

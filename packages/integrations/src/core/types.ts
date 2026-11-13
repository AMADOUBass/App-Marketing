import type { Secret } from '@app/vault';

export type PlatformId = 'facebook' | 'instagram' | 'threads' | 'youtube' | 'linkedin' | 'tiktok';

/** CLAUDE.md section 5: only transient and quota errors are retried (exponential backoff + jitter). */
export type ErrorClass = 'transient' | 'quota' | 'auth' | 'content' | 'unknown';

export const RETRYABLE_ERROR_CLASSES: readonly ErrorClass[] = ['transient', 'quota'];

/** A documented fact about a platform, with where and when it was checked (rule 5: never invented). */
export interface Sourced<T> {
  value: T;
  source: string;
  verifiedOn: string;
}

export interface ValidationIssue {
  code: string;
  /** Developer-facing explanation; the UI maps `code` to translated text. */
  detail: string;
}

/** A single image post, as the adapters receive it. */
export interface ImagePostVariant {
  caption: string;
  imageUrl: string;
  mimeType: string;
  /** Optional facts from worker-media (ffprobe), used for checks that need them. */
  widthPx?: number;
  heightPx?: number;
  sizeBytes?: number;
}

export interface PublishJob {
  /** Account id on the platform (Instagram professional account id). */
  remoteAccountId: string;
  accessToken: Secret;
  variant: ImagePostVariant;
}

export type PublishOutcome =
  /** Confirmed by the platform (rule 2). `remoteMediaId` may be unknown when confirmed by reconciliation. */
  | { status: 'published'; containerId: string; remoteMediaId: string | null }
  | {
      status: 'failed';
      errorClass: ErrorClass;
      retryable: boolean;
      containerId: string | null;
      /** Safe for logs and storage: codes only, no URLs, no tokens. */
      detail: string;
    }
  /** The publish call may or may not have reached the platform: reconcile before anything else. */
  | { status: 'unknown_outcome'; containerId: string };

export interface PublishingQuota {
  used: number;
  total: number;
  windowSeconds: number;
}

export interface PublishHooks {
  /** Called as soon as the platform returns a container id, so it is stored before the risky publish call. */
  onContainerCreated?: (containerId: string) => Promise<void> | void;
}

/**
 * Contract every platform adapter implements (CLAUDE.md section 7). Phase 0 covers image publishing;
 * media preparation, status polling of uploads, token refresh and metrics come with the publishing engine.
 */
export interface PlatformAdapter<Caps> {
  readonly platform: PlatformId;
  capabilities(): Caps;
  /** Pure: no network call. */
  validate(variant: ImagePostVariant, caps: Caps): ValidationIssue[];
  publishingQuota(remoteAccountId: string, accessToken: Secret): Promise<PublishingQuota>;
  publish(job: PublishJob, hooks?: PublishHooks): Promise<PublishOutcome>;
  /** After unknown_outcome: asks the platform what happened to this container. Never publishes. */
  reconcile(containerId: string, accessToken: Secret): Promise<PublishOutcome | null>;
  classifyError(error: unknown): ErrorClass;
}

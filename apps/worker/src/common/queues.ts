export const PUBLISH_QUEUE = 'publish';

/** Everything a publish job carries: identifiers only. Content is read inside withTenant(). */
export interface PublishJobData {
  organizationId: string;
  targetId: string;
  attemptNo: number;
}

/**
 * Deterministic job id: adding the same target attempt twice is a no-op in BullMQ.
 * BullMQ 6 rejects custom ids containing a single ':', hence '_' (CLAUDE.md said `${targetId}:${attemptNo}`).
 */
export function publishJobId(targetId: string, attemptNo: number): string {
  return `${targetId}_${String(attemptNo)}`;
}

export const RECONCILE_QUEUE = 'reconcile';

/** Asks the platform what became of an unknown outcome (ADR 013). Identifiers only. */
export interface ReconcileJobData {
  organizationId: string;
  targetId: string;
  /** Inconclusive checks so far: a job for an older check number is stale and does nothing. */
  checkNo: number;
}

export function reconcileJobId(targetId: string, checkNo: number): string {
  return `${targetId}_rc${String(checkNo)}`;
}

export const EVENTS_QUEUE = 'events';

/** An outbox event handed to the queue (ADR 013). The job id is the event id: relayed at most once. */
export interface EventJobData {
  eventId: string;
  organizationId: string;
  type: string;
  payload: unknown;
}

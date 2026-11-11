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

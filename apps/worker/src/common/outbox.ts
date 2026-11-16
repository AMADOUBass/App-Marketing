import type { PublicationState, TenantTx } from '@ponctua/db';

/** States worth telling someone about (notifications, live updates): final, or needing a human. */
const NOTIFIED_STATES: readonly PublicationState[] = ['published', 'failed', 'needs_action'];

export interface TargetEvent {
  organizationId: string;
  targetId: string;
  socialAccountId: string;
  state: PublicationState;
  reason?: string | null;
}

/**
 * Writes the outbox event in the SAME transaction as the state change (CLAUDE.md section 5): if the
 * change commits, the event exists; if it rolls back, there is no event. Identifiers and codes only.
 */
export async function recordTargetEvent(tx: TenantTx, event: TargetEvent): Promise<void> {
  if (!NOTIFIED_STATES.includes(event.state)) return;
  await tx.outboxEvent.create({
    data: {
      organizationId: event.organizationId,
      type: `publication.${event.state}`,
      payload: {
        targetId: event.targetId,
        socialAccountId: event.socialAccountId,
        state: event.state,
        reason: event.reason ?? null,
      },
    },
  });
}

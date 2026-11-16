/** Tenant-scoped database (@ponctua/db). */
export const DB = Symbol('DB');
/** pino logger. */
export const LOGGER = Symbol('LOGGER');
/** Valkey connection used by the leader lock. */
export const VALKEY = Symbol('VALKEY');
/** BullMQ queue the scheduler adds publish jobs to. */
export const PUBLISH_QUEUE_CLIENT = Symbol('PUBLISH_QUEUE_CLIENT');
/** BullMQ queue the scheduler adds reconciliation jobs to (ADR 013). */
export const RECONCILE_QUEUE_CLIENT = Symbol('RECONCILE_QUEUE_CLIENT');
/** BullMQ queue the outbox relay hands events to (ADR 013). */
export const EVENTS_QUEUE_CLIENT = Symbol('EVENTS_QUEUE_CLIENT');

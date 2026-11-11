/** Tenant-scoped database (@app/db). */
export const DB = Symbol('DB');
/** pino logger. */
export const LOGGER = Symbol('LOGGER');
/** Valkey connection used by the leader lock. */
export const VALKEY = Symbol('VALKEY');
/** BullMQ queue the scheduler adds publish jobs to. */
export const PUBLISH_QUEUE_CLIENT = Symbol('PUBLISH_QUEUE_CLIENT');

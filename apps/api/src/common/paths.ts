// Kept free of imports: also loaded by instrumentation.ts before the app starts.
export const API_PREFIX = 'api';
export const HEALTH_PATH = '/api/v1/health';

/** Health probes (liveness and readiness) are neither logged nor traced. */
export function isHealthPath(url: string | undefined): boolean {
  const path = url?.split('?')[0] ?? '';
  return path === HEALTH_PATH || path.startsWith(`${HEALTH_PATH}/`);
}

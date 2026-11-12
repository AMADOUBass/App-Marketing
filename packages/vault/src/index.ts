// Safe to import anywhere. Sealing lives in '@app/vault/seal' (API), opening in '@app/vault/open' (worker).
export type { OauthTokens } from './credentials.js';
export { VaultError } from './sealed-box.js';
export { Secret } from './secret.js';

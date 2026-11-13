// Safe to import anywhere. Sealing lives in '@ponctua/vault/seal' (API), opening in '@ponctua/vault/open' (worker).
export type { OauthTokens } from './credentials.js';
export { VaultError } from './sealed-box.js';
export { Secret } from './secret.js';

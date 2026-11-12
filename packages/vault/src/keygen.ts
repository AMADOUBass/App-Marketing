// `pnpm vault:keygen [keyId]`: prints a new master key pair for .env files (ADR 006).
// The public key goes to the API, the private key ONLY to the worker. Nothing is written to disk.
import { generateRawKeyPair, toBase64Url } from './sealed-box.js';

const keyId = process.argv[2] ?? `mk-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
if (!/^[\w-]{1,64}$/.test(keyId)) {
  process.stderr.write('key id must match [A-Za-z0-9_-]{1,64}\n');
  process.exit(1);
}

const pair = generateRawKeyPair();
process.stdout.write(
  [
    '# API (apps/api/.env): can seal tokens, cannot read them back',
    `VAULT_MASTER_KEY_ID=${keyId}`,
    `VAULT_MASTER_PUBLIC_KEY=${toBase64Url(pair.publicKey)}`,
    '',
    '# Worker ONLY (apps/worker/.env): keep every key still in use, comma-separated (rotation)',
    `VAULT_MASTER_PRIVATE_KEYS=${keyId}:${toBase64Url(pair.privateKey)}`,
    '',
  ].join('\n'),
);
pair.privateKey.fill(0);

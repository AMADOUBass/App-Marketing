// Public-key "sealed box" (ADR 006), built only on node:crypto:
//   X25519 (ephemeral sender key x recipient key) -> HKDF-SHA256 -> AES-256-GCM with associated data.
// Anyone holding the recipient PUBLIC key can seal; only the recipient PRIVATE key opens.
//
// Format v1: [version 1 byte][ephemeral public key 32][iv 12][auth tag 16][ciphertext]
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';

const VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_BYTES + IV_BYTES + TAG_BYTES;

// DER prefixes of X25519 keys (RFC 8410): raw 32-byte keys <-> Node KeyObjects.
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** What a sealed value is for. Mixed into key derivation: a box sealed for one use cannot be opened as another. */
export type SealPurpose = 'org-private-key' | 'oauth-tokens';

/** Thrown for any vault failure. Messages never contain keys, tokens or ciphertext. */
export class VaultError extends Error {
  override readonly name = 'VaultError';
}

export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new VaultError('invalid public key length');
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function privateKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== KEY_BYTES) throw new VaultError('invalid private key length');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
}

export function rawPrivateKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);
}

/** Copies into a plain ArrayBuffer-backed array (the type Prisma expects for Bytes columns). */
const toBytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(buffer);

export function generateRawKeyPair(): {
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: Uint8Array<ArrayBuffer>;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const rawPrivate = rawPrivateKey(privateKey);
  const pair = { publicKey: toBytes(rawPublicKey(publicKey)), privateKey: toBytes(rawPrivate) };
  rawPrivate.fill(0);
  return pair;
}

function deriveKey(
  shared: Buffer,
  ephemeralPublic: Buffer,
  recipientPublic: Buffer,
  purpose: SealPurpose,
): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeralPublic, recipientPublic]),
      `app-vault/v${String(VERSION)}/${purpose}`,
      KEY_BYTES,
    ),
  );
}

/**
 * Seals `plaintext` for the holder of `recipientPublicRaw`. `associatedData` is authenticated but not
 * stored: the box only opens with the exact same value (binds a token to its organization and account).
 */
export function seal(
  recipientPublicRaw: Uint8Array,
  plaintext: Uint8Array,
  associatedData: string,
  purpose: SealPurpose,
): Uint8Array<ArrayBuffer> {
  const recipientPublic = publicKeyFromRaw(recipientPublicRaw);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = rawPublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublic });
  const key = deriveKey(shared, ephemeralPublic, Buffer.from(recipientPublicRaw), purpose);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return toBytes(
    Buffer.concat([Buffer.from([VERSION]), ephemeralPublic, iv, cipher.getAuthTag(), ciphertext]),
  );
}

/** Opens a box sealed by `seal()`. Any tampering, wrong key, purpose or associated data -> VaultError. */
export function open(
  recipientPrivateRaw: Uint8Array,
  box: Uint8Array,
  associatedData: string,
  purpose: SealPurpose,
): Buffer {
  const bytes = Buffer.from(box);
  if (bytes.length < HEADER_BYTES || bytes[0] !== VERSION) {
    throw new VaultError('unsupported or truncated sealed box');
  }
  const ephemeralPublic = bytes.subarray(1, 1 + KEY_BYTES);
  const iv = bytes.subarray(1 + KEY_BYTES, 1 + KEY_BYTES + IV_BYTES);
  const tag = bytes.subarray(1 + KEY_BYTES + IV_BYTES, HEADER_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES);

  try {
    const privateKey = privateKeyFromRaw(recipientPrivateRaw);
    const recipientPublic = rawPublicKey(createPublicKey(privateKey));
    const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephemeralPublic) });
    const key = deriveKey(shared, ephemeralPublic, recipientPublic, purpose);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    // Never forward the underlying crypto error: keep the message free of any material.
    throw new VaultError('sealed box could not be opened (wrong key, tampered or mismatched data)');
  }
}

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export function fromBase64Url(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== KEY_BYTES || toBase64Url(bytes) !== value) {
    throw new VaultError(`${label} must be a base64url-encoded 32-byte key`);
  }
  return bytes;
}

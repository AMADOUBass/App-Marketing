import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A software passkey (WebAuthn authenticator), so the API tests can register and sign in like a
 * browser with Touch ID or Windows Hello would — and also send what a real one should not (no user
 * verification, wrong origin), to check the server refuses it.
 */

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

// --- Minimal CBOR encoder: what attestation objects and COSE keys need. ---
type Cbor = number | string | Uint8Array | Map<number | string, Cbor> | { [key: string]: Cbor };

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}

// Authenticator data flags (WebAuthn §6.1).
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_CREDENTIAL = 0x40;

export interface CeremonyOptions {
  /** PIN or biometrics checked by the authenticator (required by our server). */
  userVerified?: boolean;
  /** The page origin the browser reports (the server must check it). */
  origin?: string;
}

export class SoftwarePasskey {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly defaultOrigin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.publicJwk = { x: jwk.x ?? '', y: jwk.y ?? '' };
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private flags({ userVerified = true }: CeremonyOptions, extra = 0): number {
    return USER_PRESENT | (userVerified ? USER_VERIFIED : 0) | extra;
  }

  /** navigator.credentials.create() answer, as @simplewebauthn/browser would send it. */
  register(challenge: string, options: CeremonyOptions = {}) {
    const coseKey = new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags(options, ATTESTED_CREDENTIAL)]),
      Buffer.alloc(4), // sign counter 0
      Buffer.alloc(16), // AAGUID (none)
      idLength,
      this.credentialId,
      cbor(coseKey),
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.create',
      challenge,
      options.origin ?? this.defaultOrigin,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
    };
  }

  /** navigator.credentials.get() answer, signed with this passkey's private key. */
  authenticate(challenge: string, options: CeremonyOptions = {}) {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([this.flags(options)]),
      counter,
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.get',
      challenge,
      options.origin ?? this.defaultOrigin,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
    };
  }
}

import { describe, expect, it } from 'vitest';
import { generateRawKeyPair, open, seal, VaultError } from '../src/sealed-box.js';

const recipient = generateRawKeyPair();
const message = Buffer.from('IGQVJ-secret-access-token');
const aad = 'oauth-tokens:org-a:account-1';

function sealed() {
  return seal(recipient.publicKey, message, aad, 'oauth-tokens');
}

describe('sealed box', () => {
  it('round-trips with the recipient private key', () => {
    expect(open(recipient.privateKey, sealed(), aad, 'oauth-tokens').toString()).toBe(
      message.toString(),
    );
  });

  it('never contains the plaintext, and two seals of the same value differ', () => {
    const one = Buffer.from(sealed());
    const two = Buffer.from(sealed());

    expect(one.includes(message)).toBe(false);
    expect(one.equals(two)).toBe(false);
  });

  it('rejects any modified byte', () => {
    const box = sealed();
    for (const index of [0, 5, 40, 50, box.length - 1]) {
      const tampered = Buffer.from(box);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => open(recipient.privateKey, tampered, aad, 'oauth-tokens')).toThrow(VaultError);
    }
  });

  it('rejects another private key, other associated data and another purpose', () => {
    const box = sealed();

    expect(() => open(generateRawKeyPair().privateKey, box, aad, 'oauth-tokens')).toThrow(
      VaultError,
    );
    expect(() =>
      open(recipient.privateKey, box, 'oauth-tokens:org-b:account-1', 'oauth-tokens'),
    ).toThrow(VaultError);
    expect(() => open(recipient.privateKey, box, aad, 'org-private-key')).toThrow(VaultError);
  });

  it('rejects truncated or unknown-version boxes', () => {
    const box = sealed();
    expect(() => open(recipient.privateKey, box.subarray(0, 20), aad, 'oauth-tokens')).toThrow(
      VaultError,
    );
    const future = Buffer.from(box);
    future[0] = 2;
    expect(() => open(recipient.privateKey, future, aad, 'oauth-tokens')).toThrow(VaultError);
  });

  it('error messages carry no key, token or ciphertext material', () => {
    const box = Buffer.from(sealed());
    try {
      open(generateRawKeyPair().privateKey, box, aad, 'oauth-tokens');
      expect.unreachable();
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
      expect(text).not.toContain(message.toString());
      expect(text).not.toContain(box.toString('base64'));
      expect(text).not.toContain(Buffer.from(recipient.privateKey).toString('base64url'));
    }
  });
});

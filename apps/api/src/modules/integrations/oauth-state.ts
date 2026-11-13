import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Secret } from '@ponctua/vault';
import { z } from 'zod';

/**
 * OAuth `state`: signed (HMAC-SHA256) and short-lived. Meta's redirect comes back without our dev tenant
 * header, so the state is what proves which organization and workspace the new account belongs to.
 */
const payloadSchema = z.object({
  o: z.uuid(), // organization
  w: z.uuid(), // workspace
  n: z.string().min(16), // nonce
  e: z.number().int(), // expiry, unix seconds
});

export interface OAuthStateContent {
  organizationId: string;
  workspaceId: string;
}

const TTL_SECONDS = 10 * 60;

function mac(key: Secret, data: string): Buffer {
  return createHmac('sha256', key.reveal()).update(data).digest();
}

export function signOAuthState(key: Secret, content: OAuthStateContent, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      o: content.organizationId,
      w: content.workspaceId,
      n: randomBytes(16).toString('base64url'),
      e: Math.floor(now / 1000) + TTL_SECONDS,
    }),
  ).toString('base64url');
  return `${payload}.${mac(key, payload).toString('base64url')}`;
}

/** Returns the content, or null if the state is missing, forged, tampered with or expired. */
export function verifyOAuthState(
  key: Secret,
  state: string | undefined,
  now = Date.now(),
): OAuthStateContent | null {
  if (!state) return null;
  const [payload, signature, ...rest] = state.split('.');
  if (!payload || !signature || rest.length > 0) return null;

  const expected = mac(key, payload);
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  try {
    const parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString()),
    );
    if (!parsed.success || parsed.data.e * 1000 < now) return null;
    return { organizationId: parsed.data.o, workspaceId: parsed.data.w };
  } catch {
    return null;
  }
}

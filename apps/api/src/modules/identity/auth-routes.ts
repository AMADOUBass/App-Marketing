import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { type Auth, CLIENT_IP_HEADER } from './auth.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Better Auth also returns the session token in JSON bodies (for bearer use): at the top level after
 * sign-in or sign-up, and inside `session` for get-session or a passkey sign-in. The session lives in
 * an httpOnly cookie only (ADR 008): a token readable by page scripts would defeat that, so it is
 * removed from every JSON body, in both places.
 */
export function withoutSessionTokens(body: string, contentType: string | null): string {
  if (!contentType?.includes('application/json')) return body;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return body; // Not JSON after all: send as is.
  }
  if (!isRecord(json)) return body;
  const { token: _token, ...rest } = json;
  if (isRecord(rest.session)) {
    const { token: _sessionToken, ...session } = rest.session;
    rest.session = session;
  }
  return JSON.stringify(rest);
}

/**
 * Mounts Better Auth's handler on Fastify (documented Fastify integration), outside Nest's router:
 * sign-up, sign-in, sign-out and session endpoints live under /api/auth/*.
 */
export function registerAuthRoutes(fastify: FastifyInstance, auth: Auth): void {
  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
      const headers = fromNodeHeaders(request.headers);
      // Overwrites whatever the client sent: rate limits must not be dodged by a forged header.
      headers.set(CLIENT_IP_HEADER, request.ip);
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );

      reply.status(response.status);
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() !== 'set-cookie') void reply.header(name, value);
      }
      // Several cookies must stay separate headers (joining them with commas breaks Expires dates).
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) void reply.header('set-cookie', cookies);

      const body = response.body ? await response.text() : null;
      return reply.send(
        body === null ? null : withoutSessionTokens(body, response.headers.get('content-type')),
      );
    },
  });
}

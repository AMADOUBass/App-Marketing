import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { type Auth, CLIENT_IP_HEADER } from './auth.js';

/**
 * Better Auth also returns the session token in the JSON body of sign-in / sign-up (for bearer use).
 * The session lives in an httpOnly cookie only (CLAUDE.md): a token readable by page scripts would
 * defeat that, so it is removed from every JSON body.
 */
function withoutSessionToken(body: string, response: Response): string {
  if (!response.headers.get('content-type')?.includes('application/json')) return body;
  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === 'object' && 'token' in json) {
      const { token: _token, ...rest } = json as Record<string, unknown>;
      return JSON.stringify(rest);
    }
  } catch {
    // Not JSON after all: send as is.
  }
  return body;
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
      return reply.send(body === null ? null : withoutSessionToken(body, response));
    },
  });
}

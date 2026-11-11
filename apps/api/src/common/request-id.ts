import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

// Accept a caller-provided id only if it is short and safe to print (prevents log injection).
const SAFE_REQUEST_ID = /^[\w.-]{1,128}$/;

/** Fastify `genReqId`: reuse a safe incoming x-request-id, otherwise generate a UUID. */
export function generateRequestId(req: { headers: IncomingHttpHeaders }): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Echoes the request id on every response so clients can quote it in support requests. */
export function registerRequestIdHeader(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}

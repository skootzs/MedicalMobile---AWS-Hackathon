import type { FastifyReply } from 'fastify';

/** Provisional HTTP transport constraints; R4 owns eventual shared contracts. */
export const identifierSchema = { type: 'string', minLength: 1, maxLength: 100, pattern: '^\\S(?:.*\\S)?$' };
export const hashSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const paramsSchema = { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: identifierSchema } };
export const emptyQuerySchema = { type: 'object', additionalProperties: false, properties: {} };
export interface RequestParams { requestId: string }
export const errorSchema = {
  type: 'object', additionalProperties: false, required: ['error'], properties: {
    error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
      code: { type: 'string' }, message: { type: 'string' }, requestId: { type: ['string', 'null'] },
      eventId: { type: ['string', 'null'] }, workflowVersion: { type: ['integer', 'null'] }, auditId: { type: ['string', 'null'] },
    } },
  },
};
export const errorResponses = { '4xx': errorSchema, '5xx': errorSchema };
export function apiError(reply: FastifyReply, status: number, code: string, message: string,
  details: { requestId?: string | null; eventId?: string | null; workflowVersion?: number | null; auditId?: string | null } = {}) {
  return reply.code(status).send({ error: { code, message, ...details } });
}
export function notFound(reply: FastifyReply) { return apiError(reply, 404, 'REQUEST_NOT_FOUND', 'Request not found.'); }
export function unavailable(reply: FastifyReply) { return apiError(reply, 503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable.'); }

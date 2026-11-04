import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { VerifiedPrincipal } from '../auth.ts';
import type { RoutingCommand, RoutingService } from '../routing-service.ts';
import { apiError, emptyQuerySchema, errorSchema, hashSchema, identifierSchema, notFound, paramsSchema, unavailable } from './http.ts';
import type { RequestParams } from './http.ts';

type Body = Omit<RoutingCommand, 'requestId'>;
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const stringOrNull = { type: ['string', 'null'] };
const routingSchema = { type: 'object', additionalProperties: false,
  required: ['route', 'requestId', 'revision', 'snapshotHash', 'screeningId', 'confirmationId', 'reasons', 'clinicalApprovalRequired'], properties: {
    route: { type: 'string', enum: ['NOT_READY', 'NEEDS_SD_REVIEW', 'READY_FOR_BEDROCK_REVIEW'] }, requestId: stringOrNull,
    revision: { type: ['integer', 'null'] }, snapshotHash: stringOrNull, screeningId: stringOrNull, confirmationId: stringOrNull,
    reasons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'field', 'message'], properties: {
      code: { type: 'string' }, field: { type: 'string' }, message: { type: 'string' },
    } } }, clinicalApprovalRequired: { type: 'boolean', const: true },
  } };
const routingError = { ...errorSchema, properties: { ...errorSchema.properties, routing: routingSchema } };
/** Explicit HTTP command only. No browser evidence, identities or dispatch flags. */
export function registerRoutingRoute(app: FastifyInstance, service: RoutingService, principalFor: (request: FastifyRequest) => VerifiedPrincipal) {
  app.post<{ Params: RequestParams; Body: Body }>('/api/requests/:requestId/route', {
    schema: { params: paramsSchema, querystring: emptyQuerySchema,
      body: { type: 'object', additionalProperties: false, required: ['eventId', 'expectedVersion', 'revision', 'snapshotHash'], properties: {
        eventId: identifierSchema, expectedVersion: positive, revision: positive, snapshotHash: hashSchema,
      } }, response: {
        200: { type: 'object', additionalProperties: false, required: ['status', 'reason', 'requestId', 'eventId', 'workflowVersion', 'auditId', 'routing'], properties: {
          status: { type: 'string', enum: ['SUCCESS', 'DUPLICATE_EVENT'] }, reason: { type: 'string' }, requestId: identifierSchema,
          eventId: identifierSchema, workflowVersion: positive, auditId: { type: 'string' }, routing: routingSchema,
        } }, '4xx': routingError, '5xx': errorSchema,
      },
    },
  }, async (request, reply) => {
    const result = await service.execute({ ...request.body, requestId: request.params.requestId }, principalFor(request).context);
    if (result.status === 'SUCCESS' || result.status === 'DUPLICATE_EVENT') return result;
    if (result.status === 'STORAGE_FAILURE') return unavailable(reply);
    if (result.reason === 'REQUEST_NOT_FOUND') return notFound(reply);
    if (result.reason === 'INVALID_COMMAND') return apiError(reply, 400, result.reason, 'Invalid routing command.');
    if (['WRONG_ROLE', 'UNAUTHORIZED', 'IDENTITY_CHANGED'].includes(result.reason)) return apiError(reply, 403, result.reason, 'Routing is not permitted.');
    const error = { code: result.reason, message: 'The request has changed or is not ready for routing.', requestId: result.requestId,
      eventId: result.eventId, workflowVersion: result.workflowVersion, auditId: result.auditId };
    return reply.code(409).send({ error, ...(result.status === 'NOT_READY' && result.routing ? { routing: result.routing } : {}) });
  });
}

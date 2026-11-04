import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { VerifiedPrincipal } from '../auth.ts';
import type { RequestService, CreateRequestCommand, ConfirmRequestCommand, ReviseRequestCommand, RequestResult } from '../requests.ts';
import { apiError, emptyQuerySchema, errorResponses, hashSchema, identifierSchema, notFound, paramsSchema, unavailable } from './http.ts';
import type { RequestParams } from './http.ts';

type ConfirmationBody = Omit<ConfirmRequestCommand, 'requestId'>;
type RevisionBody = Omit<ReviseRequestCommand, 'requestId'>;
const nonblank = { type: 'string', minLength: 1, maxLength: 5000, pattern: '\\S' };
const contentSchema = { type: 'object', additionalProperties: false, required: ['title', 'objective', 'targetPopulation', 'requirements'], properties: {
  title: nonblank, objective: nonblank, targetPopulation: nonblank,
  requirements: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false,
    required: ['condition', 'action'], properties: { condition: nonblank, action: nonblank } } },
} };
const currentProperties = { eventId: identifierSchema, expectedVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, snapshotHash: hashSchema };
const identitySchema = { type: 'object', additionalProperties: false, required: ['requestId', 'revision', 'snapshotHash'], properties: {
  requestId: identifierSchema, revision: currentProperties.revision, snapshotHash: hashSchema,
} };
const resultSchema = { type: 'object', additionalProperties: false, required: ['status', 'reason', 'requestId', 'eventId', 'workflowVersion', 'request', 'auditId'], properties: {
  status: { type: 'string', enum: ['SUCCESS', 'DUPLICATE_EVENT'] }, reason: { type: 'string' }, requestId: identifierSchema,
  eventId: identifierSchema, workflowVersion: { type: 'integer' }, request: identitySchema, auditId: { type: 'string' },
} };
const responseSchemas = { 200: resultSchema, 201: resultSchema, ...errorResponses };
const bodySchema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
function sendResult(reply: FastifyReply, result: RequestResult, creation = false) {
  if (result.status === 'SUCCESS' || result.status === 'DUPLICATE_EVENT') return reply.code(creation && result.status === 'SUCCESS' ? 201 : 200).send(result);
  if (result.status === 'STORAGE_FAILURE') return unavailable(reply);
  if (result.reason === 'REQUEST_NOT_FOUND' || result.reason === 'WRONG_OWNER') return notFound(reply);
  if (result.reason === 'INVALID_COMMAND') return apiError(reply, 400, result.reason, 'Invalid request input.');
  if (['UNAUTHORIZED', 'WRONG_ROLE', 'IDENTITY_CHANGED'].includes(result.reason)) return apiError(reply, 403, result.reason, 'This action is not permitted.');
  return apiError(reply, 409, result.reason, 'The request has changed or is not ready for this action.', {
    requestId: result.requestId, eventId: result.eventId, workflowVersion: result.workflowVersion, auditId: result.auditId,
  });
}
/** HTTP adapters only. No screening callback or browser evidence-authority fields. */
export function registerRequestRoutes(app: FastifyInstance, service: RequestService, principalFor: (request: FastifyRequest) => VerifiedPrincipal) {
  app.post<{ Body: CreateRequestCommand }>('/api/requests', {
    schema: { querystring: emptyQuerySchema, body: bodySchema({ eventId: identifierSchema, expectedVersion: { type: 'integer', const: 0 }, content: contentSchema }), response: responseSchemas },
  }, async (request, reply) => sendResult(reply, await service.create(request.body, principalFor(request).context), true));

  app.get<{ Params: RequestParams }>('/api/requests/:requestId', {
    schema: { params: paramsSchema, querystring: emptyQuerySchema, response: { ...errorResponses,
      200: { type: 'object', additionalProperties: false,
        required: ['requestId', 'status', 'version', 'preview', 'screening', 'confirmation', 'clinicalApprovalRequired'], properties: {
          requestId: identifierSchema, status: { type: 'string' }, version: { type: 'integer' }, clinicalApprovalRequired: { type: 'boolean', const: true },
          preview: { type: 'object', additionalProperties: false, required: ['kind', 'requestId', 'revision', 'schemaVersion', 'hashPolicyVersion', 'snapshotHash', 'content'], properties: {
            kind: { type: 'string', const: 'REQUEST_PREVIEW' }, requestId: identifierSchema, revision: currentProperties.revision,
            schemaVersion: { type: 'string' }, hashPolicyVersion: { type: 'string' }, snapshotHash: hashSchema,
            // Return every hashed content field, including stored schema extensions.
            content: { type: 'object', additionalProperties: true },
          } },
          screening: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
            required: ['requestId', 'revision', 'snapshotHash', 'screeningId', 'status', 'checks'], properties: {
              ...identitySchema.properties, screeningId: identifierSchema, status: { type: 'string' },
              checks: { type: 'object', additionalProperties: false, required: ['completeness', 'ambiguities', 'contradictions', 'clinicalSafety', 'feasibility'],
                properties: Object.fromEntries(['completeness', 'ambiguities', 'contradictions', 'clinicalSafety', 'feasibility'].map(area => [area,
                  { type: 'object', additionalProperties: false, required: ['outcome', 'reasons'], properties: {
                    outcome: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } },
                  } }])) },
            } }] },
          confirmation: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
            required: ['requestId', 'revision', 'snapshotHash', 'confirmationId', 'screeningId', 'decision'], properties: {
              ...identitySchema.properties, confirmationId: identifierSchema, screeningId: identifierSchema, decision: { type: 'string' },
            } }] },
        } },
    } },
  }, async (request, reply) => {
    const result = await service.get(request.params.requestId, principalFor(request).context);
    if (result.status === 'SUCCESS') return result.request;
    return result.status === 'NOT_FOUND' ? notFound(reply) : unavailable(reply);
  });
  app.post<{ Params: RequestParams; Body: ConfirmationBody }>('/api/requests/:requestId/confirmations', {
    schema: { params: paramsSchema, querystring: emptyQuerySchema, body: bodySchema({ ...currentProperties,
      screeningId: identifierSchema, decision: { type: 'string', enum: ['CONFIRMED', 'REVISION_REQUESTED'] } }), response: responseSchemas },
  }, async (request, reply) => sendResult(reply, await service.confirm({ ...request.body, requestId: request.params.requestId }, principalFor(request).context)));
  app.post<{ Params: RequestParams; Body: RevisionBody }>('/api/requests/:requestId/revisions', {
    schema: { params: paramsSchema, querystring: emptyQuerySchema, body: bodySchema({ ...currentProperties, content: contentSchema }), response: responseSchemas },
  }, async (request, reply) => sendResult(reply, await service.revise({ ...request.body, requestId: request.params.requestId }, principalFor(request).context)));
}

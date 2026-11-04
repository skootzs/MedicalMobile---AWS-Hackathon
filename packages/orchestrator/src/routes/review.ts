import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { VerifiedPrincipal } from '../auth.ts';
import { reviewCategories } from '../reviews.ts';
import type { ReviewCategory, ReviewService, ReviewQueueResult, ReviewContextResult } from '../reviews.ts';
import { apiError, errorResponses, hashSchema, identifierSchema, notFound, paramsSchema, unavailable } from './http.ts';
import type { RequestParams } from './http.ts';

interface ReviewQuery { category: ReviewCategory; expectedVersion?: string }
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const category = { type: 'string', enum: reviewCategories };
const strings = { type: 'array', items: { type: 'string' } };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const nullable = (schema: object) => ({ anyOf: [{ type: 'null' }, schema] });
const requestProperties = { requestId: identifierSchema, revision: integer, snapshotHash: hashSchema };
const requestIdentity = object(requestProperties);
const logicProperties = { logicRevision: integer, logicHash: hashSchema };
const artifactProperties = { ...logicProperties, compilationId: identifierSchema, artifactHash: hashSchema };
const verificationProperties = { ...artifactProperties, verificationId: identifierSchema, reportHash: hashSchema, passed: { type: 'boolean' } };
const common = { requestId: identifierSchema, category, workflowVersion: integer, status: { type: 'string' }, request: requestIdentity };
const snapshot = { type: 'object', additionalProperties: false,
  required: ['kind', 'requestId', 'revision', 'schemaVersion', 'hashPolicyVersion', 'snapshotHash', 'content'], properties: {
    ...requestProperties, kind: { type: 'string', enum: ['REQUEST_PREVIEW', 'LOGIC_MODEL'] }, schemaVersion: { type: 'string' },
    hashPolicyVersion: { type: 'string' }, content: { type: 'object', additionalProperties: true }, requestPreview: requestIdentity,
  } };
const decisionCommon = { expectedVersion: integer, requestRevision: integer, requestSnapshotHash: hashSchema, ...logicProperties };
const contextSchema = object({ ...common,
  eligibility: object({ eligible: { type: 'boolean' }, reasons: strings }), preview: nullable(snapshot), logicModel: nullable(snapshot),
  checker: nullable(object({ ...logicProperties, reportId: identifierSchema, passed: { type: 'boolean' } })),
  clinicalApproval: nullable(object({ ...logicProperties, eventId: identifierSchema })), artifact: nullable(object(artifactProperties)),
  verification: nullable(object(verificationProperties)),
  screening: nullable(object({ ...requestProperties, screeningId: identifierSchema, status: { type: 'string' },
    checks: object(Object.fromEntries(['completeness', 'ambiguities', 'contradictions', 'clinicalSafety', 'feasibility'].map(area => [area,
      object({ outcome: { type: 'string' }, reasons: strings })]))) })),
  clarification: nullable(object({ routingReasons: { type: 'array', items: object({ code: { type: 'string' }, field: { type: 'string' }, message: { type: 'string' } }) } })),
  unresolvedFindings: { type: 'array', items: object({ area: { type: 'string' }, reasons: strings }) },
  decisionReferences: { anyOf: [{ type: 'null' }, object({ ...decisionCommon, checkerReportId: identifierSchema }),
    object({ ...decisionCommon, clinicalApprovalEventId: identifierSchema, compilationId: identifierSchema, artifactHash: hashSchema,
      verificationId: identifierSchema, verificationReportHash: hashSchema })] },
  clinicalApprovalRequired: { type: 'boolean', const: true },
});
function failure(reply: FastifyReply, result: Exclude<ReviewQueueResult | ReviewContextResult, { status: 'SUCCESS' }>) {
  if (result.status === 'STORAGE_FAILURE') return unavailable(reply);
  if (result.status === 'NOT_FOUND') return notFound(reply);
  if (result.status === 'INVALID_INPUT') return apiError(reply, 400, result.reason, 'Invalid review query.');
  if (result.status === 'FORBIDDEN') return apiError(reply, 403, result.reason, 'This review category is not permitted.');
  return apiError(reply, 409, result.reason, 'The review has changed or is no longer pending. Refresh the queue.');
}
/** Thin read-only handlers; category selects a view, never establishes a role. */
export function registerReviewRoutes(app: FastifyInstance, service: ReviewService, principalFor: (request: FastifyRequest) => VerifiedPrincipal) {
  app.get<{ Querystring: ReviewQuery }>('/api/reviews/queue', {
    schema: { querystring: object({ category }), response: { ...errorResponses,
      200: object({ category, items: { type: 'array', items: object(common) } }),
    } },
  }, async (request, reply) => {
    const result = await service.queue(request.query.category, principalFor(request).context);
    return result.status === 'SUCCESS' ? { category: result.category, items: result.items } : failure(reply, result);
  });
  app.get<{ Params: RequestParams; Querystring: ReviewQuery }>('/api/requests/:requestId/review-context', {
    schema: { params: paramsSchema, querystring: { ...object({ category, expectedVersion: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } }), required: ['category'] },
      response: { 200: contextSchema, ...errorResponses } },
  }, async (request, reply) => {
    const expected = request.query.expectedVersion === undefined ? undefined : Number(request.query.expectedVersion);
    const result = await service.context(request.params.requestId, request.query.category, principalFor(request).context, expected);
    return result.status === 'SUCCESS' ? result.context : failure(reply, result);
  });
}

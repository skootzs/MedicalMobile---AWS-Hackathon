import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApprovalCommand, ApprovalService } from '../approvals.ts';
import type { VerifiedPrincipal } from '../auth.ts';
import { apiError, emptyQuerySchema, errorResponses, hashSchema, identifierSchema, notFound, paramsSchema, unavailable } from './http.ts';
import type { RequestParams } from './http.ts';

type BodyFor<T extends ApprovalCommand['type']> = Omit<Extract<ApprovalCommand, { type: T }>, 'type' | 'requestId'>;
export type ClinicalDecisionBody = BodyFor<'CLINICAL_DECISION'>;
export type ReleaseDecisionBody = BodyFor<'RELEASE_DECISION'>;
type DecisionBody = ClinicalDecisionBody | ReleaseDecisionBody;
const commonProperties = {
  eventId: identifierSchema,
  expectedVersion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  requestRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  requestSnapshotHash: hashSchema,
  logicRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  logicHash: hashSchema,
  decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
  note: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
};
function bodySchema(type: ApprovalCommand['type']) {
  const extra = type === 'CLINICAL_DECISION' ? { checkerReportId: identifierSchema }
    : { clinicalApprovalEventId: identifierSchema, compilationId: identifierSchema, artifactHash: hashSchema,
        verificationId: identifierSchema, verificationReportHash: hashSchema };
  return { type: 'object', additionalProperties: false,
    required: [...Object.keys(commonProperties).filter(key => key !== 'note'), ...Object.keys(extra)],
    properties: { ...commonProperties, ...extra },
    if: { properties: { decision: { enum: ['REJECT', 'RETURN'] } }, required: ['decision'] },
    then: { required: ['note'] },
  };
}
const decisionResponse = {
  type: 'object', additionalProperties: false,
  required: ['requestId', 'eventId', 'reviewType', 'decision', 'outcome', 'decisionRecorded', 'duplicate', 'workflowVersion', 'auditId'],
  properties: {
    requestId: { type: 'string' }, eventId: { type: 'string' }, reviewType: { type: 'string', enum: ['CLINICAL_CONTENT', 'RELEASE'] },
    decision: commonProperties.decision, outcome: { type: 'string', enum: ['DECISION_RECORDED', 'DUPLICATE_EVENT'] },
    decisionRecorded: { type: 'boolean', const: true }, duplicate: { type: 'boolean' },
    workflowVersion: { type: ['integer', 'null'] }, auditId: { type: ['string', 'null'] },
  },
};
/** Thin HTTP translation only; service/workflow own all business decisions. */
export function registerApprovalRoutes(app: FastifyInstance, approvals: Pick<ApprovalService, 'execute'>,
  principalFor: (request: FastifyRequest) => VerifiedPrincipal) {
  for (const [path, type] of [
    ['clinical-decisions', 'CLINICAL_DECISION'], ['release-decisions', 'RELEASE_DECISION'],
  ] as const) {
    app.post<{ Params: RequestParams; Body: DecisionBody }>(`/api/requests/:requestId/${path}`, {
      schema: { params: paramsSchema, querystring: emptyQuerySchema, body: bodySchema(type), response: { 200: decisionResponse, ...errorResponses } },
    }, async (request, reply) => {
      const command = { ...request.body, requestId: request.params.requestId, type } as ApprovalCommand;
      const result = await approvals.execute(command, principalFor(request).context);
      if (result.status === 'SUCCESS' || result.status === 'DUPLICATE_EVENT') {
        const duplicate = result.status === 'DUPLICATE_EVENT';
        return { requestId: command.requestId, eventId: command.eventId, reviewType: type === 'CLINICAL_DECISION' ? 'CLINICAL_CONTENT' : 'RELEASE',
          decision: command.decision, outcome: duplicate ? 'DUPLICATE_EVENT' : 'DECISION_RECORDED', decisionRecorded: true,
          duplicate, workflowVersion: result.workflowVersion, auditId: result.auditId };
      }
      if (result.status === 'STORAGE_FAILURE') return unavailable(reply);
      if (result.reason === 'REQUEST_NOT_FOUND') return notFound(reply);
      const details = { requestId: result.requestId, eventId: result.eventId, workflowVersion: result.workflowVersion, auditId: result.auditId };
      if (result.reason === 'INVALID_COMMAND') return apiError(reply, 400, 'INVALID_INPUT', 'Invalid request input.');
      if (['UNAUTHORIZED', 'WRONG_ROLE', 'SELF_APPROVAL', 'REVIEWER_NOT_INDEPENDENT', 'IDENTITY_CHANGED'].includes(result.reason)) {
        return apiError(reply, 403, result.reason, 'This action is not permitted.', details);
      }
      return apiError(reply, 409, result.reason, 'The request or its evidence conflicts with this decision. Refresh the review.', details);
    });
  }
}

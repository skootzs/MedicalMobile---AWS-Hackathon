import type { FastifyInstance } from 'fastify';
import type { OrchestratorStore } from '../storage/requests.ts';
import { emptyQuerySchema, errorResponses, notFound, paramsSchema } from './http.ts';
import type { RequestParams } from './http.ts';

/** Authentication/resource access are applied by the local API factory before handlers. */
export function registerStatusRoute(app: FastifyInstance, store: OrchestratorStore) {
  app.get<{ Params: RequestParams }>('/api/requests/:requestId/status', {
    schema: { params: paramsSchema, querystring: emptyQuerySchema, response: {
      200: { type: 'object', additionalProperties: false, required: ['requestId', 'status', 'version'], properties: {
        requestId: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer', minimum: 1 },
      } }, ...errorResponses,
    } },
  }, async (request, reply) => {
    const state = await store.getWorkflow(request.params.requestId);
    return state ? { requestId: state.brief.requestId, status: state.status, version: state.version } : notFound(reply);
  });
}

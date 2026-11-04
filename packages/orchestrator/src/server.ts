import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApprovalService } from './approvals.ts';
import type { RequestService } from './requests.ts';
import type { ReviewService } from './reviews.ts';
import type { RoutingService } from './routing-service.ts';
import { registerRoutingRoute } from './routes/route.ts';
import { registerReviewRoutes } from './routes/review.ts';
import { registerRequestRoutes } from './routes/requests.ts';
import { denyAllAuthentication } from './auth.ts';
import type { AuthenticationBoundary, VerifiedPrincipal } from './auth.ts';
import type { OrchestratorStore } from './storage/requests.ts';
import { registerApprovalRoutes } from './routes/approve.ts';
import { registerStatusRoute } from './routes/status.ts';
import { apiError, notFound, unavailable } from './routes/http.ts';

export interface LocalApiDependencies {
  store: OrchestratorStore;
  approvals: Pick<ApprovalService, 'execute'>;
  /** Optional so existing approval-only local integration stays unchanged. */
  requests?: RequestService;
  reviews?: ReviewService;
  routing?: RoutingService;
  /** No default mock: omitted authentication always denies access. */
  authentication?: AuthenticationBoundary;
}
export interface LocalApi {
  inject: FastifyInstance['inject'];
  close(): Promise<void>;
}
/**
 * Local integration harness only. No listen(), raw server, start script, mock
 * provider, credentials, or production authentication is exposed by this factory.
 */
export function createLocalApi(deps: LocalApiDependencies): LocalApi {
  const app = Fastify({ logger: false, exposeHeadRoutes: false, bodyLimit: 32 * 1024,
    ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } } });
  const authentication = deps.authentication ?? denyAllAuthentication;
  const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const principal = await authentication.authenticate(request);
      if (!principal || principal.context === null || principal.context === undefined) {
        return apiError(reply, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required.');
      }
      principals.set(request, principal);
    } catch { return unavailable(reply); }
  });
  app.addHook('preHandler', async (request, reply) => {
    const principal = principals.get(request);
    if (!principal) return apiError(reply, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required.');
    // Queue has no path resource: ReviewService authorizes category and each item.
    if (deps.reviews && request.method === 'GET' && request.routeOptions.url === '/api/reviews/queue') return;
    // Creation has no existing resource: RequestService authorizes the verified PO.
    if (deps.requests && request.method === 'POST' && request.routeOptions.url === '/api/requests') return;
    const requestId = (request.params as { requestId?: string } | undefined)?.requestId;
    try {
      if (!requestId || !await authentication.canAccessRequest(principal, requestId)) return notFound(reply);
    } catch { return unavailable(reply); }
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) return apiError(reply, 400, 'INVALID_INPUT', 'Invalid request input.');
    return unavailable(reply);
  });
  app.setNotFoundHandler((_request, reply) => notFound(reply));
  registerStatusRoute(app, deps.store);
  const principalFor = (request: FastifyRequest) => {
    const principal = principals.get(request);
    if (!principal) throw new Error('Authentication guard did not establish a principal.');
    return principal;
  };
  registerApprovalRoutes(app, deps.approvals, principalFor);
  if (deps.routing) registerRoutingRoute(app, deps.routing, principalFor);
  if (deps.reviews) registerReviewRoutes(app, deps.reviews, principalFor);
  if (deps.requests) registerRequestRoutes(app, deps.requests, principalFor);
  return { inject: app.inject.bind(app), close: () => app.close() };
}

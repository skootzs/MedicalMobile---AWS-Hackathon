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
  /**
   * Register an unauthenticated GET /health liveness probe. Off by default so
   * the test harness is unchanged. Exposes only {status,mode}; no workflow data.
   */
  health?: { mode: string };
}
export interface LocalApi {
  inject: FastifyInstance['inject'];
  close(): Promise<void>;
}
/**
 * Builds the configured Fastify instance and registers every route exactly once.
 * This is the single source of route/guard wiring; createLocalApi and the
 * production bootstrap both delegate here so there is no second copy of the
 * routes, auth hooks, or approval logic. The returned instance is only exposed
 * to in-process callers: createLocalApi deliberately hides it (no listen()),
 * while buildServer() hands it to the bootstrap that owns listen()/close().
 */
export function buildApp(deps: LocalApiDependencies): FastifyInstance {
  const app = Fastify({ logger: false, exposeHeadRoutes: false, bodyLimit: 32 * 1024,
    ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } } });
  const authentication = deps.authentication ?? denyAllAuthentication;
  const principals = new WeakMap<FastifyRequest, VerifiedPrincipal>();
  // Unauthenticated liveness probe (opt-in). Registered before the auth hook's
  // effect by exempting it there; returns no workflow data.
  if (deps.health) {
    const health = deps.health;
    app.get('/health', { schema: { response: { 200: { type: 'object', additionalProperties: false,
      required: ['status', 'mode'], properties: { status: { type: 'string' }, mode: { type: 'string' } } } } } },
      async () => ({ status: 'ok', mode: health.mode }));
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (deps.health && request.method === 'GET' && request.routeOptions.url === '/health') return;
    try {
      const principal = await authentication.authenticate(request);
      if (!principal || principal.context === null || principal.context === undefined) {
        return apiError(reply, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required.');
      }
      principals.set(request, principal);
    } catch { return unavailable(reply); }
  });
  app.addHook('preHandler', async (request, reply) => {
    if (deps.health && request.method === 'GET' && request.routeOptions.url === '/health') return;
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
  return app;
}
/**
 * Local integration harness only. No listen(), raw server, start script, mock
 * provider, credentials, or production authentication is exposed by this factory.
 * The underlying Fastify instance is intentionally hidden so tests cannot start
 * a listening socket from the harness.
 */
export function createLocalApi(deps: LocalApiDependencies): LocalApi {
  const app = buildApp(deps);
  return { inject: app.inject.bind(app), close: () => app.close() };
}
/**
 * Production composition seam: returns the full Fastify instance so the owning
 * bootstrap can call listen()/close(). It reuses buildApp(), so routes, auth
 * hooks and approval logic are never duplicated. A real AuthenticationBoundary
 * must be supplied; omitting it falls back to denyAllAuthentication (fail
 * closed), exactly as the harness does.
 */
export function buildServer(deps: LocalApiDependencies): FastifyInstance {
  return buildApp(deps);
}

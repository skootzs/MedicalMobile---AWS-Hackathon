import type { FastifyRequest } from 'fastify';

/** Returned only by trusted server authentication code, never from a request body. */
export interface VerifiedPrincipal {
  /** Opaque verified context understood by the same identity source as service/store. */
  readonly context: unknown;
}
/** Provisional, replaceable server boundary. No authentication implementation here. */
export interface AuthenticationBoundary {
  authenticate(request: Pick<FastifyRequest, 'headers' | 'raw'>): VerifiedPrincipal | null | Promise<VerifiedPrincipal | null>;
  /** Request-level access only. Decision roles/independence stay in ApprovalService/workflow. */
  canAccessRequest(principal: VerifiedPrincipal, requestId: string): boolean | Promise<boolean>;
}
/** Safe default: headers/body claims never produce a principal. */
export const denyAllAuthentication: AuthenticationBoundary = {
  authenticate: () => null,
  canAccessRequest: () => false,
};

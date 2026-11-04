/**
 * LOCAL / DEMO ONLY identity provider. NOT a production authentication
 * mechanism. It trusts a fixed set of Bearer tokens that map to FICTIONAL
 * Cognito-shaped identities, so the existing workflow, role separation and
 * approval gates can be demonstrated end to end without a live Cognito pool.
 *
 * This module must only ever be wired by local-mode startup (MODE=local) or by
 * tests. The production bootstrap never imports it for AWS mode; AWS mode uses
 * verified Cognito claims and fails closed until JWT verification lands.
 *
 * The identities here are the SAME group->role mapping real Cognito users get
 * (see cognito-auth.ts), so what the demo exercises matches production role
 * behavior — only the token-verification step is faked.
 */
import type { IdentityProvider } from './bootstrap.ts';
import type { VerifiedCognitoClaims } from './cognito-auth.ts';
import { resolveCognitoActor } from './cognito-auth.ts';

export interface DemoUser {
  readonly token: string;
  readonly claims: VerifiedCognitoClaims;
}

/** Fictional demo users, one per R7 Cognito group plus combined-role examples. */
export const DEMO_USERS: readonly DemoUser[] = Object.freeze<DemoUser[]>([
  { token: 'demo-po', claims: { sub: 'demo-po', groups: ['po'] } },
  { token: 'demo-designer', claims: { sub: 'demo-designer', groups: ['service_designer'] } },
  { token: 'demo-clinician', claims: { sub: 'demo-clinician', groups: ['clinician'] } },
  { token: 'demo-release', claims: { sub: 'demo-release', groups: ['release_approver'] } },
  { token: 'demo-developer', claims: { sub: 'demo-developer', groups: ['developer'] } },
  // A PO who is ALSO a clinician: used to prove self-approval is still blocked
  // (the author of a request cannot clinically approve their own work).
  { token: 'demo-po-clinician', claims: { sub: 'demo-po', groups: ['po', 'clinician'] } },
]);

const BEARER = /^Bearer (.+)$/;

function claimsForHeader(authorization: string | undefined): VerifiedCognitoClaims | null {
  if (typeof authorization !== 'string') return null;
  const match = BEARER.exec(authorization);
  if (!match) return null;
  const token = match[1].trim();
  return DEMO_USERS.find(u => u.token === token)?.claims ?? null;
}

/**
 * Build the local/demo identity provider. `visibility` optionally restricts
 * which request IDs a demo user may access; by default every demo user can see
 * requests whose IDs start with the demo prefix, mirroring a simple membership
 * policy. Fine-grained decision authority still lives in the workflow.
 */
export function createDemoIdentity(options: { requestPrefix?: string } = {}): IdentityProvider {
  // RequestService assigns IDs of the form `req-<sha256>`, so demo users can see
  // the requests they create. Override only in focused tests.
  const prefix = options.requestPrefix ?? 'req-';
  const resolveActor = (principal: unknown) => resolveCognitoActor(principal);
  const canAccess = (principal: unknown, requestId: string) =>
    resolveCognitoActor(principal) !== null && typeof requestId === 'string' && requestId.startsWith(prefix);
  return {
    resolveActor,
    authentication: {
      authenticate(request) {
        const claims = claimsForHeader(request.headers.authorization);
        return claims ? Object.freeze({ context: claims }) : null;
      },
      canAccessRequest(principal, requestId) {
        return canAccess(principal.context, requestId);
      },
    },
    canAccessRequestForReview: (principal, requestId) => canAccess(principal, requestId),
    canAccessRequestContext: (principal, requestId) => canAccess(principal, requestId),
  };
}

/** Convenience for demo scripts/tests: the Authorization header for a demo user. */
export const demoHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Cognito identity mapping for the production composition root.
 *
 * SCOPE (Milestone 1): this module maps VERIFIED Cognito claims to workflow
 * actors and request access. It deliberately does NOT implement JWT signature
 * verification yet (that is a later milestone requiring the pool's JWKS). Until
 * a real verifier is wired, AWS mode uses `pendingCognitoAuthentication`, which
 * fails closed exactly like denyAllAuthentication: no token is ever trusted, so
 * protected endpoints stay inaccessible. This is intentional — a half-trusted
 * verifier is worse than none.
 *
 * Group -> role mapping follows R7's Cognito groups (infra/terraform/cognito.tf:
 * po, service_designer, clinician, developer, release_approver).
 */
import type { AuthenticationBoundary, VerifiedPrincipal } from './auth.ts';
import type { Actor, Role } from './workflow.ts';

/** The shape a real JWT verifier must produce from a verified Cognito ID token. */
export interface VerifiedCognitoClaims {
  /** Stable per-user subject (Cognito `sub`); used for self-approval/independence checks. */
  readonly sub: string;
  /** `cognito:groups` from the verified token. */
  readonly groups: readonly string[];
}

/** R7 Cognito group -> orchestrator workflow Role. */
const GROUP_TO_ROLE: Readonly<Record<string, Role>> = Object.freeze({
  po: 'PO',
  service_designer: 'SERVICE_DESIGNER',
  clinician: 'CLINICIAN',
  release_approver: 'RELEASE_APPROVER',
  // 'developer' drives orchestrator-initiated transitions (routing, compilation
  // and verification starts), which the workflow guards with the ORCHESTRATOR
  // role. Worker roles (DRAFTER/CHECKER/COMPILER/VERIFIER) are NOT granted to a
  // human group: those belong to authenticated R3/R4/R5/R6/R7 service identities
  // via their own resolver, never a browser session.
  developer: 'ORCHESTRATOR',
});

/** True only for a non-empty object with a string `sub` and a string[] `groups`. */
export function isVerifiedCognitoClaims(value: unknown): value is VerifiedCognitoClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Record<string, unknown>;
  return typeof claims.sub === 'string' && claims.sub.trim() !== ''
    && Array.isArray(claims.groups) && claims.groups.every(g => typeof g === 'string');
}

/**
 * Map verified Cognito claims (passed through as the VerifiedPrincipal.context)
 * to a workflow Actor. Returns null when the context is not verified claims or
 * carries no recognized group — the caller then denies, never defaults a role.
 */
export function resolveCognitoActor(principal: unknown): Actor | null {
  if (!isVerifiedCognitoClaims(principal)) return null;
  const roles: Role[] = [];
  for (const group of principal.groups) {
    const role = GROUP_TO_ROLE[group];
    if (role && !roles.includes(role)) roles.push(role);
  }
  if (roles.length === 0) return null;
  return Object.freeze({ id: principal.sub, roles: Object.freeze(roles) });
}

/**
 * Fail-closed boundary for AWS mode until JWT verification lands. authenticate
 * always returns null, so every request is 401. This keeps production honest:
 * no fake user, no unverified token, no bypass.
 */
export const pendingCognitoAuthentication: AuthenticationBoundary = Object.freeze({
  authenticate: () => null,
  canAccessRequest: () => false,
});

/**
 * Request-level access policy used once a real verifier supplies claims. A
 * verified user may access a request when they carry at least one recognized
 * role. Fine-grained decision authority (independence, self-approval) stays in
 * the workflow/ApprovalService, not here.
 */
export function cognitoCanAccessRequest(principal: VerifiedPrincipal, _requestId: string): boolean {
  return resolveCognitoActor(principal.context) !== null;
}

/**
 * Cognito identity and authorization for AWS mode.
 *
 * - resolveCognitoActor maps VERIFIED Cognito claims to a workflow Actor.
 * - createCognitoAuthentication wraps aws-jwt-verify's CognitoJwtVerifier to
 *   verify a Bearer access token's signature, issuer, user pool, client id,
 *   token_use and expiry, then derives the principal's claims from the verified
 *   token. Nothing is trusted from the request body.
 * - Request-level access is AUTHORITATIVE: it reads the request's ownerId and
 *   current status from durable storage. A user may access a request only if
 *   they own it or hold the reviewer role whose queue currently contains it.
 *
 * Group -> role mapping follows R7's Cognito groups (infra/terraform/cognito.tf:
 * po, service_designer, clinician, developer, release_approver).
 */
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { AuthenticationBoundary, VerifiedPrincipal } from './auth.ts';
import type { Actor, Role, WorkflowState, WorkflowStatus } from './workflow.ts';

/** The verified claims the auth boundary attaches as the principal context. */
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

/** Reviewer role -> the workflow status whose queue that role owns. */
const REVIEWER_STATUS: Partial<Record<Role, WorkflowStatus>> = Object.freeze({
  SERVICE_DESIGNER: 'NEEDS_SD_REVIEW',
  CLINICIAN: 'WAITING_FOR_CLINICAL_APPROVAL',
  RELEASE_APPROVER: 'WAITING_FOR_RELEASE_APPROVAL',
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

/** The minimal verifier shape (so tests can inject a verifier with a hydrated JWKS). */
export interface TokenVerifier {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface CognitoAuthOptions {
  userPoolId: string;
  clientId: string;
  /** Default 'access'; configurable for a later decision without a rewrite. */
  tokenUse?: 'access' | 'id';
  /** Reads authoritative workflow state for request-level access decisions. */
  getWorkflow(requestId: string): Promise<WorkflowState | null>;
  /** Test seam: inject a verifier with a pre-hydrated JWKS (no network). */
  verifier?: TokenVerifier;
}

const BEARER = /^Bearer (.+)$/;

/** Extract verified claims into the minimal principal context we trust downstream. */
function claimsFromVerifiedToken(payload: Record<string, unknown>): VerifiedCognitoClaims | null {
  const sub = payload.sub;
  const groups = payload['cognito:groups'];
  const groupList = Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
  if (typeof sub !== 'string' || sub.trim() === '') return null;
  return Object.freeze({ sub, groups: Object.freeze(groupList) });
}

/**
 * Authoritative request-level access: owner OR the reviewer whose queue holds
 * the request at its current status. Reads durable state; never trusts the body.
 */
export async function cognitoCanAccessRequest(
  getWorkflow: (requestId: string) => Promise<WorkflowState | null>,
  claims: unknown,
  requestId: string,
): Promise<boolean> {
  const actor = resolveCognitoActor(claims);
  if (!actor || typeof requestId !== 'string' || requestId.trim() === '') return false;
  let state: WorkflowState | null;
  try { state = await getWorkflow(requestId); } catch { return false; }
  if (!state) return false;
  if (state.ownerId === actor.id) return true;
  for (const role of actor.roles) {
    const status = REVIEWER_STATUS[role];
    if (status && state.status === status) return true;
  }
  return false;
}

/**
 * Build the AWS-mode AuthenticationBoundary. Verifies the Bearer access token
 * with aws-jwt-verify and attaches the verified claims as the principal context.
 * Any verification failure (missing/malformed/invalid/expired/wrong audience or
 * token_use) yields null -> 401. Fails closed.
 */
export function createCognitoAuthentication(options: CognitoAuthOptions): AuthenticationBoundary {
  if (!options.userPoolId || !options.clientId) throw new Error('Cognito authentication requires userPoolId and clientId.');
  const verifier: TokenVerifier = options.verifier ?? CognitoJwtVerifier.create({
    userPoolId: options.userPoolId,
    tokenUse: options.tokenUse ?? 'access',
    clientId: options.clientId,
  });
  return {
    async authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string') return null;
      const match = BEARER.exec(header);
      if (!match) return null;
      let payload: Record<string, unknown>;
      try { payload = await verifier.verify(match[1].trim()); }
      catch { return null; } // invalid/expired/wrong pool/client/use -> unauthenticated
      const claims = claimsFromVerifiedToken(payload);
      return claims ? Object.freeze({ context: claims }) : null;
    },
    canAccessRequest(principal: VerifiedPrincipal, requestId: string) {
      return cognitoCanAccessRequest(options.getWorkflow, principal.context, requestId);
    },
  };
}

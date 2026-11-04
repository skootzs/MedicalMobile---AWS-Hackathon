import { routeDesignBrief } from './routing.ts';
import type { DesignBrief, POConfirmation, PreliminaryScreening, RevisionIdentity, RoutingResult } from './routing.ts';

/** Provisional R2 contracts. R4 owns the eventual shared schema. */
export type Role = 'PO' | 'SERVICE_DESIGNER' | 'DRAFTER' | 'CHECKER' | 'CLINICIAN'
  | 'COMPILER' | 'VERIFIER' | 'RELEASE_APPROVER' | 'ORCHESTRATOR';
export interface Actor { id: string; roles: readonly Role[] }
export type WorkflowStatus = 'WAITING_FOR_SCREENING' | 'WAITING_FOR_PO_CONFIRMATION'
  | 'READY_TO_ROUTE' | 'NEEDS_SD_REVIEW' | 'READY_FOR_LOGIC_PROPOSAL' | 'DRAFTING_LOGIC'
  | 'WAITING_FOR_LOGIC_CHECKS' | 'WAITING_FOR_CLINICAL_APPROVAL' | 'CLINICALLY_APPROVED'
  | 'COMPILING' | 'WAITING_FOR_VERIFICATION' | 'VERIFYING' | 'WAITING_FOR_RELEASE_APPROVAL'
  | 'RELEASE_APPROVED' | 'DOWNLOAD_READY' | 'RETURNED_FOR_CLARIFICATION' | 'REJECTED' | 'FAILED';
export interface LogicIdentity { logicRevision: number; logicHash: string }
export interface ArtifactIdentity extends LogicIdentity { compilationId: string; artifactHash: string }
export interface VerificationEvidence extends ArtifactIdentity {
  verificationId: string;
  reportHash: string;
  passed: boolean;
}
export interface Approval { actorId: string; eventId: string }
export interface WorkflowState {
  status: WorkflowStatus;
  version: number;
  ownerId: string;
  brief: DesignBrief;
  /** All contributors across revisions; conservative independence policy. */
  contributorIds: readonly string[];
  screening: PreliminaryScreening | null;
  confirmation: POConfirmation | null;
  routing: RoutingResult | null;
  logic: LogicIdentity | null;
  checks: (LogicIdentity & { reportId: string; passed: boolean; invocationId?: string }) | null;
  clinicalApproval: (LogicIdentity & Approval) | null;
  compilationId: string | null;
  compilerId: string | null;
  artifact: ArtifactIdentity | null;
  verificationId: string | null;
  verification: VerificationEvidence | null;
  releaseApproval: (VerificationEvidence & Approval) | null;
  /** Diagnostic only; transitions still require explicit guarded events. */
  stoppedAt: WorkflowStatus | null;
  processedEvents: readonly { eventId: string; fingerprint: string }[];
}

type Payload =
  | { type: 'SUBMIT'; brief: DesignBrief }
  | { type: 'SCREENING_COMPLETED'; screening: PreliminaryScreening }
  | { type: 'PO_DECISION'; confirmation: POConfirmation }
  | { type: 'APPLY_ROUTING'; result: RoutingResult }
  | { type: 'START_LOGIC_PROPOSAL' }
  | ({ type: 'LOGIC_PROPOSED' | 'REVISE_LOGIC' } & LogicIdentity)
  | ({ type: 'LOGIC_CHECKED'; reportId: string; passed: boolean; invocationId?: string } & LogicIdentity)
  | ({ type: 'CLINICAL_DECISION'; decision: 'APPROVE' | 'REJECT' | 'RETURN'; note?: string } & LogicIdentity)
  | { type: 'START_COMPILATION'; compilationId: string }
  | { type: 'COMPILED'; artifact: ArtifactIdentity }
  | { type: 'START_VERIFICATION'; verificationId: string }
  | { type: 'VERIFIED'; evidence: VerificationEvidence }
  | { type: 'RELEASE_DECISION'; evidence: VerificationEvidence; decision: 'APPROVE' | 'REJECT' | 'RETURN'; note?: string }
  | { type: 'MAKE_DOWNLOAD_AVAILABLE' }
  | { type: 'REVISE_REQUEST'; brief: DesignBrief }
  | { type: 'FAIL'; note: string; logicRevision?: number; logicHash?: string; compilationId?: string; verificationId?: string };
/** Actor and evidence must be established by the backend, never copied from a browser. */
export type WorkflowEvent = Payload & {
  eventId: string;
  actor: Actor;
  /** Expected optimistic concurrency version; 0 for initial submission. */
  expectedVersion: number;
  /** Current request/preview identity, including on revision commands. */
  request: RevisionIdentity;
};
export interface ProposedAuditEvent {
  eventId: string;
  requestId: string | null;
  actorId: string | null;
  outcome: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
  reason: string;
  from: WorkflowStatus | null;
  to: WorkflowStatus | null;
  stateVersion: number;
  eventType: string;
  note: string | null;
  attemptedRequest: RevisionIdentity | null;
  request: RevisionIdentity | null;
  logic: LogicIdentity | null;
  artifactHash: string | null;
}
export interface TransitionResult {
  outcome: 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
  state: WorkflowState | null;
  audit: ProposedAuditEvent;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.trim() === v;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function validRequest(v: unknown): v is RevisionIdentity {
  return isObject(v) && id(v.requestId) && positive(v.revision) && hash(v.snapshotHash);
}
function sameRequest(a: RevisionIdentity, b: RevisionIdentity): boolean {
  return a.requestId === b.requestId && a.revision === b.revision && a.snapshotHash === b.snapshotHash;
}
function validLogic(v: unknown): v is LogicIdentity {
  return isObject(v) && positive(v.logicRevision) && hash(v.logicHash);
}
function sameLogic(a: LogicIdentity | null, b: unknown): boolean {
  return a !== null && validLogic(b) && a.logicHash === b.logicHash && a.logicRevision === b.logicRevision;
}
function validArtifact(v: unknown): v is ArtifactIdentity {
  return validLogic(v) && isObject(v) && id(v.compilationId) && hash(v.artifactHash);
}
function sameArtifact(a: ArtifactIdentity | null, b: unknown): boolean {
  return a !== null && validArtifact(b) && sameLogic(a, b) && a.compilationId === b.compilationId && a.artifactHash === b.artifactHash;
}
function validVerification(v: unknown): v is VerificationEvidence {
  return validArtifact(v) && isObject(v) && id(v.verificationId) && hash(v.reportHash) && typeof v.passed === 'boolean';
}
/** Deterministic JSON fingerprint for event-ID reuse detection; not a snapshot hash. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObject(v)) return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
function emptyEvidence() {
  return { screening: null, confirmation: null, routing: null, logic: null, checks: null,
    clinicalApproval: null, compilationId: null, compilerId: null, artifact: null, verificationId: null,
    verification: null, releaseApproval: null, stoppedAt: null };
}
function clearBuild() {
  return { compilationId: null, compilerId: null, artifact: null, verificationId: null, verification: null, releaseApproval: null, stoppedAt: null };
}

/**
 * Pure transition over authoritative stored state and ordinary JSON events.
 * No clock, random IDs, queues, I/O, or real approval/authentication assertions.
 * Backend persistence must atomically save state, event receipt, and audit.
 * Stored state is trusted; this is not a validator for arbitrary browser state.
 */
export function transitionWorkflow(state: WorkflowState | null, event: WorkflowEvent): TransitionResult {
  const raw: unknown = event;
  const eventObject = isObject(raw) ? raw : {};
  const actor = isObject(eventObject.actor) ? eventObject.actor : {};
  const finish = (outcome: TransitionResult['outcome'], reason: string, next = state): TransitionResult => ({
    outcome, state: next,
    audit: {
      eventId: id(eventObject.eventId) ? eventObject.eventId : '(invalid)',
      actorId: id(actor.id) ? actor.id : null,
      requestId: state?.brief.requestId ?? (validRequest(eventObject.request) ? eventObject.request.requestId : null),
      outcome, reason, from: state?.status ?? null, to: next?.status ?? null,
      stateVersion: next?.version ?? 0, eventType: typeof eventObject.type === 'string' ? eventObject.type : '(invalid)',
      note: typeof eventObject.note === 'string' ? eventObject.note : null,
      attemptedRequest: validRequest(eventObject.request) ? { requestId: eventObject.request.requestId, revision: eventObject.request.revision, snapshotHash: eventObject.request.snapshotHash } : null,
      request: next ? { requestId: next.brief.requestId, revision: next.brief.revision, snapshotHash: next.brief.snapshotHash } : null,
      logic: next?.logic ? { ...next.logic } : null, artifactHash: next?.artifact?.artifactHash ?? null,
    },
  });
  const reject = (reason: string) => finish('REJECTED', reason);
  if (!id(eventObject.eventId) || !id(actor.id) || !Array.isArray(actor.roles) ||
      actor.roles.length === 0 || actor.roles.some(role => !id(role)) || !validRequest(eventObject.request)) {
    return reject('INVALID_EVENT');
  }
  // JSON-only contract: reject unserializable input rather than executing effects.
  let fingerprint: string;
  try { fingerprint = canonical(event); } catch { return reject('INVALID_EVENT'); }
  const previous = state?.processedEvents.find(item => item.eventId === event.eventId);
  if (previous) return previous.fingerprint === fingerprint ? finish('DUPLICATE', 'ALREADY_PROCESSED') : reject('EVENT_ID_REUSED');
  if (!Number.isSafeInteger(event.expectedVersion) || event.expectedVersion !== (state?.version ?? 0)) return reject('VERSION_CONFLICT');
  if (state && !sameRequest(state.brief, event.request)) return reject('STALE_REQUEST');
  const has = (role: Role) => event.actor.roles.includes(role);
  const requireRole = (...roles: Role[]) => roles.some(has);
  const independent = () => !!state && !state.contributorIds.includes(event.actor.id) && event.actor.id !== state.ownerId;
  const allowed = (...statuses: WorkflowStatus[]) => !!state && statuses.includes(state.status);
  let next: WorkflowState;
  let contributor = false;

  if (event.type === 'SUBMIT') {
    if (state) return reject('ALREADY_SUBMITTED');
    if (!has('PO')) return reject('WRONG_ROLE');
    if (!validRequest(event.brief) || !sameRequest(event.brief, event.request) || event.brief.revision !== 1) return reject('INVALID_REQUEST');
    next = { ...emptyEvidence(), status: 'WAITING_FOR_SCREENING', version: 0,
      ownerId: event.actor.id, brief: structuredClone(event.brief), contributorIds: [event.actor.id], processedEvents: [] };
  } else {
    if (!state) return reject('NOT_SUBMITTED');
    next = structuredClone(state);
    switch (event.type) {
      case 'SCREENING_COMPLETED': {
        if (!has('DRAFTER')) return reject('WRONG_ROLE');
        if (!allowed('WAITING_FOR_SCREENING')) return reject('WRONG_STATE');
        if (!isObject(event.screening) || !validRequest(event.screening) || !sameRequest(state.brief, event.screening) || !id(event.screening.screeningId)) return reject('INVALID_SCREENING');
        // Reuse the router's screening validation without duplicating its checks.
        const probe = routeDesignBrief({ currentRevision: state.brief, currentScreeningId: event.screening.screeningId,
          brief: state.brief, screening: event.screening,
          confirmation: { ...event.request, confirmationId: 'validation-only', screeningId: event.screening.screeningId, decision: 'CONFIRMED' } });
        if (probe.route === 'NOT_READY') return reject('SCREENING_NOT_READY');
        next.screening = structuredClone(event.screening);
        next.status = 'WAITING_FOR_PO_CONFIRMATION'; contributor = true; break;
      }
      case 'PO_DECISION':
        if (!has('PO') || event.actor.id !== state.ownerId) return reject('WRONG_ROLE');
        if (!allowed('WAITING_FOR_PO_CONFIRMATION') || !state.screening) return reject('WRONG_STATE');
        if (!isObject(event.confirmation) || !validRequest(event.confirmation) || !sameRequest(state.brief, event.confirmation) ||
            !id(event.confirmation.confirmationId) || event.confirmation.screeningId !== state.screening.screeningId ||
            !['CONFIRMED', 'REVISION_REQUESTED'].includes(event.confirmation.decision)) return reject('INVALID_CONFIRMATION');
        next.confirmation = structuredClone(event.confirmation);
        next.status = event.confirmation.decision === 'CONFIRMED' ? 'READY_TO_ROUTE' : 'RETURNED_FOR_CLARIFICATION'; break;
      case 'APPLY_ROUTING': {
        if (!has('ORCHESTRATOR')) return reject('WRONG_ROLE');
        if (!isObject(event.result) || event.result.route === 'NOT_READY') return reject('NOT_READY');
        if (!allowed('READY_TO_ROUTE') || !state.screening || !state.confirmation) return reject('WRONG_STATE');
        const expected = routeDesignBrief({ currentRevision: state.brief, currentScreeningId: state.screening.screeningId,
          brief: state.brief, screening: state.screening, confirmation: state.confirmation });
        if (expected.route === 'NOT_READY' || canonical(expected) !== canonical(event.result)) return reject('INVALID_ROUTING_EVIDENCE');
        next.routing = structuredClone(expected);
        next.status = expected.route === 'NEEDS_SD_REVIEW' ? 'NEEDS_SD_REVIEW' : 'READY_FOR_LOGIC_PROPOSAL'; break;
      }
      case 'START_LOGIC_PROPOSAL':
        if (!has('ORCHESTRATOR')) return reject('WRONG_ROLE');
        if (!allowed('READY_FOR_LOGIC_PROPOSAL')) return reject('WRONG_STATE');
        next.status = 'DRAFTING_LOGIC'; break;
      case 'LOGIC_PROPOSED':
      case 'REVISE_LOGIC':
        if (!has('DRAFTER')) return reject('WRONG_ROLE');
        if (event.type === 'LOGIC_PROPOSED' ? !allowed('DRAFTING_LOGIC') : !state.logic) return reject('WRONG_STATE');
        if (!validLogic(event) || event.logicRevision !== (event.type === 'LOGIC_PROPOSED' ? 1 : state.logic!.logicRevision + 1) ||
            (state.logic && event.logicHash === state.logic.logicHash)) return reject('INVALID_LOGIC_REVISION');
        next = { ...next, ...clearBuild(), checks: null, clinicalApproval: null,
          logic: { logicHash: event.logicHash, logicRevision: event.logicRevision }, status: 'WAITING_FOR_LOGIC_CHECKS' };
        contributor = true; break;
      case 'LOGIC_CHECKED':
        if (!has('CHECKER')) return reject('WRONG_ROLE');
        if (!allowed('WAITING_FOR_LOGIC_CHECKS')) return reject('WRONG_STATE');
        if (!sameLogic(state.logic, event) || !id(event.reportId) || typeof event.passed !== 'boolean') return reject('INVALID_CHECK_EVIDENCE');
        next.checks = { ...state.logic!, reportId: event.reportId, passed: event.passed, ...(event.invocationId === undefined ? {} : { invocationId: event.invocationId }) };
        next.status = event.passed ? 'WAITING_FOR_CLINICAL_APPROVAL' : 'FAILED';
        next.stoppedAt = event.passed ? null : state.status; contributor = true; break;
      case 'CLINICAL_DECISION':
        if (!has('CLINICIAN')) return reject('WRONG_ROLE');
        if (!independent()) return reject('SELF_APPROVAL');
        if (!allowed('WAITING_FOR_CLINICAL_APPROVAL')) return reject('WRONG_STATE');
        if (!sameLogic(state.logic, event) || !state.checks?.passed || !sameLogic(state.logic, state.checks)) return reject('INVALID_CLINICAL_EVIDENCE');
        if (!['APPROVE', 'REJECT', 'RETURN'].includes(event.decision) || (event.decision !== 'APPROVE' && !id(event.note))) return reject('INVALID_DECISION');
        next.status = event.decision === 'APPROVE' ? 'CLINICALLY_APPROVED' : event.decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION';
        next.stoppedAt = event.decision === 'APPROVE' ? null : state.status;
        if (event.decision === 'APPROVE') next.clinicalApproval = { ...state.logic!, actorId: event.actor.id, eventId: event.eventId };
        break;
      case 'START_COMPILATION':
        if (!has('ORCHESTRATOR')) return reject('WRONG_ROLE');
        if (!allowed('CLINICALLY_APPROVED')) return reject('WRONG_STATE');
        if (!id(event.compilationId) || !state.clinicalApproval || !sameLogic(state.logic, state.clinicalApproval) || !state.checks?.passed || !sameLogic(state.logic, state.checks)) return reject('CLINICAL_APPROVAL_REQUIRED');
        next.compilationId = event.compilationId; next.status = 'COMPILING'; break;
      case 'COMPILED':
        if (!has('COMPILER')) return reject('WRONG_ROLE');
        if (!allowed('COMPILING')) return reject('WRONG_STATE');
        if (!validArtifact(event.artifact) || !sameLogic(state.logic, event.artifact) || event.artifact.compilationId !== state.compilationId ||
            !state.clinicalApproval || !sameLogic(state.logic, state.clinicalApproval)) return reject('INVALID_ARTIFACT');
        if (event.actor.id === state.clinicalApproval.actorId) return reject('REVIEWER_NOT_INDEPENDENT');
        next.compilerId = event.actor.id;
        next.artifact = structuredClone(event.artifact); next.status = 'WAITING_FOR_VERIFICATION'; contributor = true; break;
      case 'START_VERIFICATION':
        if (!has('ORCHESTRATOR')) return reject('WRONG_ROLE');
        if (!allowed('WAITING_FOR_VERIFICATION') || !state.artifact) return reject('WRONG_STATE');
        if (!id(event.verificationId)) return reject('INVALID_VERIFICATION_ID');
        next.verificationId = event.verificationId; next.status = 'VERIFYING'; break;
      case 'VERIFIED':
        if (!has('VERIFIER')) return reject('WRONG_ROLE');
        if (!allowed('VERIFYING')) return reject('WRONG_STATE');
        if (!validVerification(event.evidence) || !sameArtifact(state.artifact, event.evidence) || event.evidence.verificationId !== state.verificationId) return reject('INVALID_VERIFICATION_EVIDENCE');
        if (event.actor.id === state.clinicalApproval?.actorId || event.actor.id === state.compilerId) return reject('REVIEWER_NOT_INDEPENDENT');
        next.verification = structuredClone(event.evidence);
        next.status = event.evidence.passed ? 'WAITING_FOR_RELEASE_APPROVAL' : 'FAILED';
        next.stoppedAt = event.evidence.passed ? null : state.status; contributor = true; break;
      case 'RELEASE_DECISION':
        if (!has('RELEASE_APPROVER')) return reject('WRONG_ROLE');
        if (!independent() || event.actor.id === state.clinicalApproval?.actorId) return reject('REVIEWER_NOT_INDEPENDENT');
        if (!allowed('WAITING_FOR_RELEASE_APPROVAL')) return reject('WRONG_STATE');
        if (!validVerification(event.evidence) || !event.evidence.passed || !state.verification?.passed || canonical(event.evidence) !== canonical(state.verification) ||
            !sameArtifact(state.artifact, event.evidence) || !state.clinicalApproval || !sameLogic(state.logic, state.clinicalApproval)) return reject('INVALID_RELEASE_EVIDENCE');
        if (!['APPROVE', 'REJECT', 'RETURN'].includes(event.decision) || (event.decision !== 'APPROVE' && !id(event.note))) return reject('INVALID_DECISION');
        next.status = event.decision === 'APPROVE' ? 'RELEASE_APPROVED' : event.decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION';
        next.stoppedAt = event.decision === 'APPROVE' ? null : state.status;
        if (event.decision === 'APPROVE') next.releaseApproval = { ...event.evidence, actorId: event.actor.id, eventId: event.eventId };
        break;
      case 'MAKE_DOWNLOAD_AVAILABLE':
        if (!has('ORCHESTRATOR')) return reject('WRONG_ROLE');
        if (!allowed('RELEASE_APPROVED')) return reject('WRONG_STATE');
        if (!state.releaseApproval || !state.verification?.passed || !sameArtifact(state.artifact, state.releaseApproval) ||
            !sameLogic(state.logic, state.clinicalApproval) || state.releaseApproval.verificationId !== state.verification.verificationId ||
            state.releaseApproval.reportHash !== state.verification.reportHash) return reject('RELEASE_APPROVAL_REQUIRED');
        next.status = 'DOWNLOAD_READY'; break;
      case 'REVISE_REQUEST':
        if (!(has('PO') && event.actor.id === state.ownerId) &&
            !(has('SERVICE_DESIGNER') && allowed('NEEDS_SD_REVIEW', 'RETURNED_FOR_CLARIFICATION')) &&
            !(has('DRAFTER') && allowed('WAITING_FOR_SCREENING', 'RETURNED_FOR_CLARIFICATION'))) return reject('WRONG_ROLE');
        if (!validRequest(event.brief) || event.brief.requestId !== state.brief.requestId || event.brief.revision !== state.brief.revision + 1 || event.brief.snapshotHash === state.brief.snapshotHash) return reject('INVALID_REQUEST_REVISION');
        next = { ...next, ...emptyEvidence(), brief: structuredClone(event.brief), status: 'WAITING_FOR_SCREENING' }; contributor = true; break;
      case 'FAIL': {
        const responsible: Partial<Record<WorkflowStatus, Role>> = {
          WAITING_FOR_SCREENING: 'DRAFTER', DRAFTING_LOGIC: 'DRAFTER', WAITING_FOR_LOGIC_CHECKS: 'CHECKER', COMPILING: 'COMPILER', VERIFYING: 'VERIFIER',
        };
        const role = responsible[state.status];
        if (!role || !requireRole(role)) return reject('WRONG_ROLE_OR_STATE');
        if (!id(event.note)) return reject('FAILURE_NOTE_REQUIRED');
        if (state.logic && !sameLogic(state.logic, event)) return reject('STALE_FAILURE');
        if (state.status === 'COMPILING' && event.compilationId !== state.compilationId) return reject('STALE_FAILURE');
        if (state.status === 'VERIFYING' && event.verificationId !== state.verificationId) return reject('STALE_FAILURE');
        next.status = 'FAILED'; next.stoppedAt = state.status; break;
      }
      default: return reject('UNKNOWN_EVENT');
    }
  }
  if (contributor && !next.contributorIds.includes(event.actor.id)) next.contributorIds = [...next.contributorIds, event.actor.id];
  next.version = (state?.version ?? 0) + 1;
  next.processedEvents = [...next.processedEvents, { eventId: event.eventId, fingerprint }];
  return finish('ACCEPTED', event.type, next);
}

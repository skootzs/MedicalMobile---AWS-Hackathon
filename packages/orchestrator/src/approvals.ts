import { checkerEvidenceMatches } from './checker-contracts.ts';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import { transitionWorkflow } from './workflow.ts';
import type { Actor, WorkflowEvent, WorkflowState, VerificationEvidence } from './workflow.ts';
import type { RevisionIdentity } from './routing.ts';
import type { Snapshot } from './snapshots.ts';
import type { EvidenceRecord } from './storage/artifacts.ts';
import type { ApplyResult, OrchestratorStore, StoreDependencies, WorkflowCommand } from './storage/requests.ts';
import { StorageError } from './storage/requests.ts';

/** Provisional R2 application contract; R4 still owns eventual shared schemas. */
interface ApprovalBase {
  requestId: string;
  expectedVersion: number;
  eventId: string;
  requestRevision: number;
  requestSnapshotHash: string;
  logicRevision: number;
  logicHash: string;
  decision: 'APPROVE' | 'REJECT' | 'RETURN';
  note?: string;
}
export type ApprovalCommand = ApprovalBase & (
  | { type: 'CLINICAL_DECISION'; checkerReportId: string }
  | { type: 'RELEASE_DECISION'; clinicalApprovalEventId: string; compilationId: string;
      artifactHash: string; verificationId: string; verificationReportHash: string }
);
export interface ApprovalResult {
  status: 'SUCCESS' | 'REJECTED' | 'STALE_VERSION' | 'DUPLICATE_EVENT' | 'STORAGE_FAILURE';
  reason: string;
  requestId: string | null;
  eventId: string | null;
  workflowVersion: number | null;
  auditId: string | null;
  replayed: boolean;
}
export interface ApprovalServiceDependencies {
  store: OrchestratorStore;
  /** Same authenticated, request-scoped identity source used by the store. No mock default. */
  resolveActor: StoreDependencies['resolveActor'];
  /** Internal backend attempt ID, not an identity supplied in the client command. */
  newAttemptId?: () => string;
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const requestIdentity = (c: ApprovalCommand): RevisionIdentity => ({ requestId: c.requestId, revision: c.requestRevision, snapshotHash: c.requestSnapshotHash });
const currentRequest = (s: WorkflowState): RevisionIdentity => ({ requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash });
function matchesLogic(s: WorkflowState, v: { logicRevision: number; logicHash: string }) {
  return s.logic?.logicRevision === v.logicRevision && s.logic.logicHash === v.logicHash;
}
function parseCommand(raw: unknown): ApprovalCommand | null {
  try {
    // Strict JSON copy rejects executable values, hidden fields and non-finite numbers.
    const v: unknown = JSON.parse(canonicalizeJson(raw));
    if (!object(v)) return null;
    const common = ['requestId', 'expectedVersion', 'eventId', 'requestRevision', 'requestSnapshotHash', 'logicRevision', 'logicHash', 'decision', 'note', 'type'];
    const extra = v.type === 'CLINICAL_DECISION' ? ['checkerReportId'] : v.type === 'RELEASE_DECISION'
      ? ['clinicalApprovalEventId', 'compilationId', 'artifactHash', 'verificationId', 'verificationReportHash'] : null;
    if (!extra || Object.keys(v).some(k => ![...common, ...extra].includes(k)) || !id(v.requestId) || !id(v.eventId) ||
        typeof v.expectedVersion !== 'number' || !Number.isSafeInteger(v.expectedVersion) || v.expectedVersion < 0 ||
        !positive(v.requestRevision) || !hash(v.requestSnapshotHash) || !positive(v.logicRevision) || !hash(v.logicHash) ||
        !['APPROVE', 'REJECT', 'RETURN'].includes(v.decision as string) ||
        (v.note !== undefined && (typeof v.note !== 'string' || !v.note.trim())) ||
        (v.decision !== 'APPROVE' && v.note === undefined)) return null;
    if (v.type === 'CLINICAL_DECISION' ? !id(v.checkerReportId)
      : !id(v.clinicalApprovalEventId) || !id(v.compilationId) || !hash(v.artifactHash) || !id(v.verificationId) || !hash(v.verificationReportHash)) return null;
    return v as unknown as ApprovalCommand;
  } catch { return null; }
}
/** Internal shared event mapping for application submission and read-only guard probes.
 * References for a rejected release command are never asserted to be passing evidence. */
export function commandEvent(c: ApprovalCommand, evidence?: VerificationEvidence): WorkflowCommand {
  const common = { eventId: c.eventId, expectedVersion: c.expectedVersion, request: requestIdentity(c),
    decision: c.decision, ...(c.note === undefined ? {} : { note: c.note }) };
  return c.type === 'CLINICAL_DECISION'
    ? { ...common, type: c.type, logicRevision: c.logicRevision, logicHash: c.logicHash }
    : { ...common, type: c.type, evidence: evidence ?? { logicRevision: c.logicRevision, logicHash: c.logicHash,
        compilationId: c.compilationId, artifactHash: c.artifactHash, verificationId: c.verificationId,
        reportHash: c.verificationReportHash, passed: false } };
}
function findEvidence(records: readonly EvidenceRecord[], kind: EvidenceRecord['kind'], recordId: string, request: RevisionIdentity): EvidenceRecord | null {
  const found = records.filter(r => r.kind === kind && r.recordId === recordId && r.event.type === kind &&
    r.requestId === request.requestId && same(r.event.request, request));
  return found.length === 1 ? found[0] : null;
}
/** Internal shared evidence check for submissions and read-only review context.
 * Validate reference bindings, not roles/state transitions (those stay in workflow.ts). */
export function evidenceFailure(c: ApprovalCommand, s: WorkflowState | null, preview: Snapshot | null, model: Snapshot | null, records: readonly EvidenceRecord[]): string | undefined {
  if (!s) return 'REQUEST_NOT_FOUND';
  if (s.version !== c.expectedVersion) return 'VERSION_CONFLICT';
  const request = currentRequest(s);
  if (!same(requestIdentity(c), request)) return 'STALE_REQUEST';
  if (!s.logic) return 'LOGIC_REQUIRED';
  if (!matchesLogic(s, c)) return 'STALE_LOGIC';
  if (!preview || preview.kind !== 'REQUEST_PREVIEW' || preview.requestId !== c.requestId || preview.revision !== c.requestRevision || preview.snapshotHash !== c.requestSnapshotHash ||
      !model || model.kind !== 'LOGIC_MODEL' || model.requestId !== c.requestId || model.revision !== c.logicRevision || model.snapshotHash !== c.logicHash || !same(model.requestPreview, request)) return 'SNAPSHOT_REQUIRED';
  if (s.checks?.passed !== true || !matchesLogic(s, s.checks)) return 'CHECKER_EVIDENCE_REQUIRED';
  if (c.type === 'CLINICAL_DECISION' && c.checkerReportId !== s.checks.reportId) return 'CHECKER_EVIDENCE_MISMATCH';
  const checkedRecord = findEvidence(records, 'LOGIC_CHECKED', s.checks.reportId, request);
  const checked = checkedRecord?.event;
  if (!checked || checked.type !== 'LOGIC_CHECKED' || checked.passed !== true || checked.reportId !== s.checks.reportId || !matchesLogic(s, checked)) return 'CHECKER_EVIDENCE_REQUIRED';
  if (s.checks.invocationId !== undefined || checked.invocationId !== undefined || checkedRecord?.checkerResult !== undefined) {
    if (s.checks.invocationId !== checked.invocationId || !checkerEvidenceMatches(checkedRecord?.checkerResult, { request, logic: s.logic, reportId: s.checks.reportId,
      eventId: checked.eventId, invocationId: s.checks.invocationId, passed: true, actorId: checked.actor.id })) return 'CHECKER_EVIDENCE_REQUIRED';
  }
  if (c.type === 'CLINICAL_DECISION') return;
  if (!s.clinicalApproval || !matchesLogic(s, s.clinicalApproval)) return 'CLINICAL_APPROVAL_REQUIRED';
  if (c.clinicalApprovalEventId !== s.clinicalApproval.eventId) return 'CLINICAL_APPROVAL_MISMATCH';
  const clinical = findEvidence(records, 'CLINICAL_DECISION', c.clinicalApprovalEventId, request)?.event;
  if (!clinical || clinical.type !== 'CLINICAL_DECISION' || clinical.decision !== 'APPROVE' || clinical.eventId !== s.clinicalApproval.eventId ||
      clinical.actor.id !== s.clinicalApproval.actorId || !matchesLogic(s, clinical)) return 'CLINICAL_APPROVAL_REQUIRED';
  if (!s.artifact || !matchesLogic(s, s.artifact) || s.artifact.compilationId !== s.compilationId) return 'ARTIFACT_REQUIRED';
  if (c.artifactHash !== s.artifact.artifactHash || c.compilationId !== s.artifact.compilationId) return 'STALE_ARTIFACT';
  const compiled = findEvidence(records, 'COMPILED', c.compilationId, request)?.event;
  if (!compiled || compiled.type !== 'COMPILED' || !same(compiled.artifact, s.artifact) || compiled.actor.id !== s.compilerId) return 'ARTIFACT_EVIDENCE_REQUIRED';
  if (s.verification?.passed !== true || !matchesLogic(s, s.verification) || s.verification.verificationId !== s.verificationId ||
      s.verification.artifactHash !== s.artifact.artifactHash || s.verification.compilationId !== s.artifact.compilationId) return 'VERIFICATION_REQUIRED';
  if (c.verificationId !== s.verification.verificationId || c.verificationReportHash !== s.verification.reportHash) return 'VERIFICATION_EVIDENCE_MISMATCH';
  const verified = findEvidence(records, 'VERIFIED', c.verificationId, request)?.event;
  if (!verified || verified.type !== 'VERIFIED' || !same(verified.evidence, s.verification)) return 'VERIFICATION_EVIDENCE_REQUIRED';
}

/** Small application coordinator. No HTTP, AWS, database, or real authentication. */
export class ApprovalService {
  #deps: ApprovalServiceDependencies;
  constructor(deps: ApprovalServiceDependencies) {
    if (!deps.store || typeof deps.resolveActor !== 'function') throw new Error('Storage and a trusted backend identity provider are required.');
    this.#deps = deps;
  }
  async execute(input: ApprovalCommand, principal: unknown): Promise<ApprovalResult> {
    const c = parseCommand(input);
    const result = (status: ApprovalResult['status'], reason: string, stored?: ApplyResult): ApprovalResult => ({
      status, reason, requestId: c?.requestId ?? null, eventId: c?.eventId ?? null,
      workflowVersion: stored?.version ?? null, auditId: stored?.auditId ?? null, replayed: stored?.replayed ?? false,
    });
    if (!c) return result('REJECTED', 'INVALID_COMMAND');
    const commandFingerprint = createHash('sha256').update(canonicalizeJson(c), 'utf8').digest('hex');
    let actor: Actor | null;
    try { actor = structuredClone(await this.#deps.resolveActor(principal, c.requestId)); }
    catch { actor = null; }
    let event = commandEvent(c);
    let failure: string | undefined;
    try {
      if (!actor || !id(actor.id) || !Array.isArray(actor.roles)) {
        actor = null; failure = 'UNAUTHORIZED';
      } else {
        const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (receipt?.commandFingerprint === commandFingerprint) {
          // Rebuild an exact retry from immutable accepted evidence, even after revisions.
          const records = await this.#deps.store.listEvidence(c.requestId);
          const matching = records.filter(r => r.kind === c.type && r.event.eventId === c.eventId);
          if (matching.length !== 1) return result('STORAGE_FAILURE', 'APPROVAL_RECEIPT_INTEGRITY');
          const { actor: originalActor, ...storedEvent } = matching[0].event;
          event = storedEvent;
        } else if (receipt) {
          failure = 'EVENT_ID_REUSED';
        } else {
          const state = await this.#deps.store.getWorkflow(c.requestId);
          const request = state ? currentRequest(state) : requestIdentity(c);
          const preview = state ? await this.#deps.store.getSnapshot({ kind: 'REQUEST_PREVIEW', requestId: c.requestId, revision: state.brief.revision }) : null;
          const model = state?.logic ? await this.#deps.store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: c.requestId,
            revision: state.logic.logicRevision, requestPreview: request }) : null;
          const records = state ? await this.#deps.store.listEvidence(c.requestId) : [];
          failure = evidenceFailure(c, state, preview, model, records);
          if (!failure && c.type === 'RELEASE_DECISION') event = commandEvent(c, state!.verification!);
          const proposal = transitionWorkflow(state, { ...event, actor } as WorkflowEvent);
          if (!failure && proposal.outcome === 'REJECTED') failure = proposal.audit.reason;
          if (proposal.outcome === 'DUPLICATE') return result('STORAGE_FAILURE', 'MISSING_EVENT_RECEIPT');
        }
      }
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), event,
        commandFingerprint, ...(actor ? { expectedActorId: actor.id } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'DUPLICATE' || stored.replayed && stored.outcome === 'ACCEPTED') return result('DUPLICATE_EVENT', stored.reason, stored);
      if (stored.outcome === 'ACCEPTED') return result('SUCCESS', stored.reason, stored);
      const stale = ['VERSION_CONFLICT', 'STALE_REQUEST', 'STALE_LOGIC', 'STALE_ARTIFACT'].includes(stored.reason);
      return result(stale ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
    } catch (error) {
      return result('STORAGE_FAILURE', error instanceof StorageError ? error.code : 'STORAGE_UNAVAILABLE');
    }
  }
}

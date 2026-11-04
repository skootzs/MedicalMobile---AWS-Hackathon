import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import { createCompilationIntent, referenceMatches } from './compilation-contracts.ts';
import type { CompilationJobIntent, LogicModelReferenceProvider } from './compilation-contracts.ts';
import { checkerReportHash } from './checker-contracts.ts';
import { validateCompilationPayload } from './r7-handoff-contract.ts';
import { toCompilePayload } from './compilation-contracts.ts';
import { compilationEvidenceFailure } from './compilation-eligibility.ts';
import type { CompilationStore } from './storage/compilations.ts';
import type { ApplyResult, StoreDependencies } from './storage/requests.ts';
import type { EventReceipt } from './storage/audit.ts';
import type { Actor } from './workflow.ts';
import type { RevisionIdentity } from './routing.ts';

export interface CompilationCommand extends RevisionIdentity {
  eventId: string;
  expectedVersion: number;
  logicModelRevision: number;
  logicModelHash: string;
  clinicalApprovalId: string;
}
export interface CompilationHandoffDependencies {
  store: CompilationStore;
  resolveActor: StoreDependencies['resolveActor'];
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Optional policy may restrict ORCHESTRATOR authority; never elevate other roles. */
  authorizeActor?(actor: Readonly<Actor>, requestId: string): boolean | Promise<boolean>;
  snapshotReferences: LogicModelReferenceProvider;
  now?: () => string;
  newAttemptId?: () => string;
}
export interface CompilationHandoffResult {
  status: 'INTENT_RECORDED' | 'DUPLICATE_EVENT' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  job: CompilationJobIntent | null;
  workflowVersion: number | null;
  auditId: string | null;
}
const identity = (c: RevisionIdentity): RevisionIdentity => ({ requestId: c.requestId, revision: c.revision, snapshotHash: c.snapshotHash });
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function parse(input: CompilationCommand): CompilationCommand | null {
  try {
    const c = JSON.parse(canonicalizeJson(input));
    const keys = ['requestId', 'eventId', 'expectedVersion', 'revision', 'snapshotHash', 'logicModelRevision', 'logicModelHash', 'clinicalApprovalId'];
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== keys.length || Object.keys(c).some(k => !keys.includes(k)) ||
        ![c.requestId, c.eventId, c.clinicalApprovalId].every(checkerId) || ![c.expectedVersion, c.revision, c.logicModelRevision].every(checkerVersionNumber) ||
        !hash(c.snapshotHash) || !hash(c.logicModelHash)) return null;
    return c;
  } catch { return null; }
}
/** Extends the existing apply()/handoff pattern; no runner, listener, compiler or publisher. */
export class CompilationHandoffService {
  #deps: CompilationHandoffDependencies;
  constructor(deps: CompilationHandoffDependencies) {
    if (typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function' || typeof deps.store?.getCompilationJob !== 'function' ||
        typeof deps.store?.getCheckerReport !== 'function' ||
        typeof deps.snapshotReferences?.getVerifiedReference !== 'function') throw Error('Trusted identity, access, compilation storage, checker-report evidence and immutable snapshot provider are required.');
    this.#deps = deps;
  }
  async #retry(c: CompilationCommand, receipt: EventReceipt): Promise<CompilationJobIntent> {
    const job = receipt.compilationJobId ? await this.#deps.store.getCompilationJob(c.requestId, receipt.compilationJobId) : null;
    if (!job || job.handoffEventId !== c.eventId || job.sourceWorkflowVersion !== c.expectedVersion || receipt.workflowVersion !== job.workflowVersion ||
        !checkerSame(receipt.request, identity(c)) || !checkerSame(job.requestPreview, identity(c)) || job.logicModelRevision !== c.logicModelRevision ||
        job.logicModelHash !== c.logicModelHash || job.clinicalApprovalId !== c.clinicalApprovalId) throw Error('Compilation receipt integrity failure.');
    return job;
  }
  async start(input: CompilationCommand, principal: unknown): Promise<CompilationHandoffResult> {
    const c = parse(input);
    const reply = (status: CompilationHandoffResult['status'], reason: string, stored?: ApplyResult, job: CompilationJobIntent | null = null): CompilationHandoffResult => ({
      status, reason, job, workflowVersion: job?.workflowVersion ?? stored?.version ?? null, auditId: stored?.auditId ?? null,
    });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      const actor: Actor | null = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !checkerId(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      let failure = !actor.roles.includes('ORCHESTRATOR') || this.#deps.authorizeActor && await this.#deps.authorizeActor(actor, c.requestId) !== true ? 'WRONG_ROLE' : undefined;
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor.id })).digest('hex');
      let job: CompilationJobIntent | null = null;
      if (!failure) {
        const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (receipt?.commandFingerprint === fingerprint) job = await this.#retry(c, receipt);
        else {
          const s = await this.#deps.store.getWorkflow(c.requestId);
          if (receipt) failure = 'EVENT_ID_REUSED';
          else if (!s) failure = 'REQUEST_NOT_FOUND';
          else if (s.version !== c.expectedVersion) failure = 'VERSION_CONFLICT';
          else if (!checkerSame(identity(s.brief), identity(c))) failure = 'STALE_REQUEST';
          else if (!s.logic || s.logic.logicRevision !== c.logicModelRevision || s.logic.logicHash !== c.logicModelHash) failure = 'STALE_LOGIC';
          else if (s.status !== 'CLINICALLY_APPROVED') failure = 'WRONG_STATE';
          else if (s.clinicalApproval?.eventId !== c.clinicalApprovalId) failure = 'CLINICAL_APPROVAL_MISMATCH';
          else {
            const preview = await this.#deps.store.getSnapshot({ kind: 'REQUEST_PREVIEW', requestId: c.requestId, revision: c.revision });
            const model = await this.#deps.store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: c.requestId, revision: c.logicModelRevision, requestPreview: identity(c) });
            const records = await this.#deps.store.listEvidence(c.requestId);
            const checked = records.find(r => r.kind === 'LOGIC_CHECKED' && r.recordId === s.checks?.reportId && checkerSame(r.event.request, identity(c)));
            const clinicalReceipt = await this.#deps.store.getReceipt(c.requestId, c.clinicalApprovalId);
            const checkerReceipt = checked ? await this.#deps.store.getReceipt(c.requestId, checked.event.eventId) : null;
            failure = compilationEvidenceFailure(s, preview, model, records, clinicalReceipt, checkerReceipt);
            if (!failure && model?.kind === 'LOGIC_MODEL') {
              const supplied = await this.#deps.snapshotReferences.getVerifiedReference(model);
              // Copy immediately: provider data cannot mutate the command while identity is rechecked.
              const ref = supplied ? JSON.parse(canonicalizeJson(supplied)) : null;
              // R7's checkReportHash must be the digest of the canonical R4 checker
              // report JSON. Load the accepted checker result bound to this request's
              // reportId/logic and derive the hash; fail closed if it is unavailable
              // or does not match the exact logic under compilation.
              const checkerResult = await this.#deps.store.getCheckerReport(c.requestId, s.checks!.reportId);
              const reportBindsLogic = !!checkerResult && checkerResult.report.reportId === s.checks!.reportId &&
                checkerSame(checkerResult.report.logic, { logicRevision: c.logicModelRevision, logicHash: c.logicModelHash }) &&
                checkerResult.report.requestId === c.requestId;
              if (!referenceMatches(ref, model)) failure = 'VERIFIED_SNAPSHOT_REFERENCE_REQUIRED';
              else if (!reportBindsLogic) failure = 'CHECKER_REPORT_EVIDENCE_REQUIRED';
              else {
                job = createCompilationIntent({ requestId: c.requestId, revision: c.revision, requestPreview: identity(c), logicModelRevision: c.logicModelRevision,
                  logicModelHash: model.snapshotHash, logicModelUri: ref.uri, snapshotReference: ref, clinicalApprovalId: s.clinicalApproval!.eventId,
                  checkerReportId: s.checks!.reportId, checkerInvocationId: s.checks!.invocationId!, checkReportHash: checkerReportHash(checkerResult!.report),
                  sourceWorkflowVersion: s.version, handoffEventId: c.eventId, createdBy: actor.id, createdAt: (this.#deps.now ?? (() => new Date().toISOString()))() });
                // Fail closed if the outgoing COMPILE_LOGIC payload would not satisfy R7's schema.
                if (!validateCompilationPayload(toCompilePayload(job)).ok) { job = null; failure = 'R7_PAYLOAD_INVALID'; }
              }
            }
          }
        }
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
        const latestActor = await this.#deps.resolveActor(principal, c.requestId);
        if (!latestActor || latestActor.id !== actor.id || !latestActor.roles.includes('ORCHESTRATOR')) failure = 'IDENTITY_CHANGED';
        else if (this.#deps.authorizeActor && await this.#deps.authorizeActor(latestActor, c.requestId) !== true) failure = 'WRONG_ROLE';
        const latest = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (latest?.commandFingerprint === fingerprint && !['WRONG_ROLE', 'IDENTITY_CHANGED'].includes(failure ?? '')) { job = await this.#retry(c, latest); failure = undefined; }
        else if (latest && latest.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      }
      if (!job && !failure) failure = 'COMPILATION_INTENT_REQUIRED';
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), expectedActorId: actor.id,
        commandFingerprint: fingerprint, event: { type: 'START_COMPILATION', eventId: c.eventId, expectedVersion: c.expectedVersion,
          request: identity(c), compilationId: job?.jobId ?? 'not-authorized' }, ...(job ? { compilationIntent: job } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return reply(['VERSION_CONFLICT', 'STALE_REQUEST', 'STALE_LOGIC'].includes(stored.reason) ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      if (!receipt) return reply('STORAGE_FAILURE', 'COMPILATION_RECEIPT_INTEGRITY');
      const saved = await this.#retry(c, receipt);
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'INTENT_RECORDED', stored.reason, { ...stored, auditId: receipt.auditId }, saved);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

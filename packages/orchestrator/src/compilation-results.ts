import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import { artifactMatches, executionMatchesJob, parseCompilationExecution } from './compilation-result-contracts.ts';
import type { CompilationArtifactVerifier, CompilationExecutionSource, CompilationResultRecord } from './compilation-result-contracts.ts';
import type { CompilationJobIntent } from './compilation-contracts.ts';
import { compilationEvidenceFailure } from './compilation-eligibility.ts';
import type { CompilationResultStore } from './storage/compilation-results.ts';
import type { ApplyResult, StoreDependencies, WorkflowCommand } from './storage/requests.ts';
import type { Actor } from './workflow.ts';
import type { EventReceipt } from './storage/audit.ts';

/** Notification hints only. Hashes, status, roles and artifact URIs are never accepted here. */
export interface CompilationResultCommand { requestId: string; jobId: string; eventId: string; expectedVersion: number; attempt: number; executionRecordVersion: string }
export interface CompilationResultDependencies {
  store: CompilationResultStore;
  resolveActor: StoreDependencies['resolveActor'];
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Required server policy mapping verified R7 service identities, not generic developer access. */
  authorizeRunner(actor: Readonly<Actor>, job: CompilationJobIntent): boolean | Promise<boolean>;
  executions: CompilationExecutionSource;
  artifacts?: CompilationArtifactVerifier;
  newAttemptId?: () => string;
}
export interface CompilationIngestionResult {
  status: 'ACCEPTED' | 'DUPLICATE_EVENT' | 'BLOCKED' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string; result: CompilationResultRecord | null; workflowVersion: number | null; auditId: string | null; attemptAuditId: string | null;
}
function parse(input: CompilationResultCommand): CompilationResultCommand | null {
  try {
    const c = JSON.parse(canonicalizeJson(input)), fields = ['requestId','jobId','eventId','expectedVersion','attempt','executionRecordVersion'];
    return c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === fields.length && Object.keys(c).every(k => fields.includes(k)) &&
      [c.requestId,c.jobId,c.eventId,c.executionRecordVersion].every(checkerId) && [c.expectedVersion,c.attempt].every(checkerVersionNumber) ? c : null;
  } catch { return null; }
}
const stale = (r: string) => ['VERSION_CONFLICT','STALE_JOB','STALE_JOB_ATTEMPT','STALE_LOGIC','STALE_REQUEST'].includes(r);
const blocked = (r: string) => ['JOB_NOT_COMPLETED','ARTIFACT_VERIFICATION_UNAVAILABLE','ARTIFACT_EVIDENCE_REQUIRED','EXECUTION_EVIDENCE_UNAVAILABLE','BUILD_EVIDENCE_REQUIRED'].includes(r);
/** Internal ingestion only. Does not execute the compiler, consume queues or start R6. */
export class CompilationResultService {
  #deps: CompilationResultDependencies;
  constructor(deps: CompilationResultDependencies) {
    if (typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function' || typeof deps.authorizeRunner !== 'function' ||
        typeof deps.executions?.getCurrent !== 'function' || typeof deps.store?.getCompilationResult !== 'function') throw Error('Trusted runner policy, identity, execution source and result store required.');
    this.#deps = deps;
  }
  async #retry(c: CompilationResultCommand, receipt: EventReceipt): Promise<CompilationResultRecord> {
    const r = await this.#deps.store.getCompilationResult(c.requestId, c.jobId);
    if (!r || r.eventId !== c.eventId || r.execution.attempt !== c.attempt || r.execution.recordVersion !== c.executionRecordVersion ||
        r.execution.jobWorkflowVersion !== c.expectedVersion || !checkerSame(receipt.compilationResult ?? null, r)) throw Error('Compilation result receipt integrity failure.');
    return r;
  }
  async ingest(input: CompilationResultCommand, principal: unknown): Promise<CompilationIngestionResult> {
    const c = parse(input);
    const reply = (status: CompilationIngestionResult['status'], reason: string, stored?: ApplyResult, result: CompilationResultRecord | null = null, receipt?: EventReceipt): CompilationIngestionResult => ({
      status, reason, result, workflowVersion: result?.acceptedWorkflowVersion ?? stored?.version ?? null, auditId: receipt?.auditId ?? stored?.auditId ?? null, attemptAuditId: stored?.auditId ?? null,
    });
    if (!c) return reply('REJECTED','INVALID_COMMAND');
    try {
      const actor: Actor | null = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !checkerId(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED','UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED','REQUEST_NOT_FOUND');
      const job = await this.#deps.store.getCompilationJob(c.requestId, c.jobId);
      if (!job) return reply('REJECTED','JOB_NOT_FOUND');
      let failure = !actor.roles.includes('COMPILER') || !await this.#deps.authorizeRunner(actor, job) ? 'WORKER_NOT_AUTHORIZED' : undefined;
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor.id })).digest('hex');
      let accepted: CompilationResultRecord | null = null;
      let execution = null as ReturnType<typeof parseCompilationExecution>;
      if (!failure) {
        const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (receipt?.commandFingerprint === fingerprint) accepted = await this.#retry(c, receipt);
        else {
          const s = await this.#deps.store.getWorkflow(c.requestId);
          if (receipt) failure = 'EVENT_ID_REUSED';
          else if (!s) failure = 'REQUEST_NOT_FOUND';
          else if (s.version !== c.expectedVersion || job.workflowVersion !== c.expectedVersion) failure = 'VERSION_CONFLICT';
          else if (!checkerSame({ requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash }, job.requestPreview) ||
            !s.logic || s.logic.logicRevision !== job.logicModelRevision || s.logic.logicHash !== job.logicModelHash) failure = 'STALE_JOB';
          else if (s.status !== 'COMPILING' || s.compilationId !== job.jobId) failure = 'WRONG_STATE';
          else if (s.clinicalApproval?.eventId !== job.clinicalApprovalId) failure = 'CLINICAL_APPROVAL_MISMATCH';
          else if (s.clinicalApproval.actorId === actor.id) failure = 'REVIEWER_NOT_INDEPENDENT';
          else {
            const preview = await this.#deps.store.getSnapshot({ kind: 'REQUEST_PREVIEW', requestId: c.requestId, revision: job.revision });
            const model = await this.#deps.store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: c.requestId, revision: job.logicModelRevision, requestPreview: job.requestPreview });
            const records = await this.#deps.store.listEvidence(c.requestId), clinical = await this.#deps.store.getReceipt(c.requestId, job.clinicalApprovalId);
            const check = records.find(r => r.kind === 'LOGIC_CHECKED' && r.recordId === job.checkerReportId);
            const checked = check ? await this.#deps.store.getReceipt(c.requestId, check.event.eventId) : null;
            failure = compilationEvidenceFailure(s, preview, model, records, clinical, checked);
            if (!failure && model?.kind === 'LOGIC_MODEL') {
              const rawExecution = await this.#deps.executions.getCurrent(c.requestId, c.jobId);
              execution = parseCompilationExecution(rawExecution);
              if (!execution) failure = rawExecution == null ? 'EXECUTION_EVIDENCE_UNAVAILABLE' : 'MALFORMED_EXECUTION_EVIDENCE';
              else if (!executionMatchesJob(execution, job)) failure = 'EXECUTION_EVIDENCE_MISMATCH';
              else if (execution.runnerActorId !== actor.id) failure = 'WORKER_NOT_AUTHORIZED';
              else if (execution.attempt !== c.attempt || execution.recordVersion !== c.executionRecordVersion) failure = 'STALE_JOB_ATTEMPT';
              else if (['QUEUED','RUNNING'].includes(execution.status)) failure = 'JOB_NOT_COMPLETED';
              else {
                let artifact: CompilationResultRecord['artifact'] = null;
                if (execution.status === 'SUCCEEDED') {
                  if (execution.chtConfStatus !== 'PASSED') failure = 'BUILD_EVIDENCE_REQUIRED';
                  else if (![execution.compileArtifactHash,execution.artifactHash,execution.artifactUri,execution.artifactVersionId,execution.manifestUri,execution.manifestHash,execution.manifestVersionId,execution.reportUri,execution.reportHash,execution.reportVersionId,execution.inputHash].every(Boolean)) failure = 'ARTIFACT_EVIDENCE_REQUIRED';
                  else if (!this.#deps.artifacts) failure = 'ARTIFACT_VERIFICATION_UNAVAILABLE';
                  else {
                    let verified;
                    try { verified = await this.#deps.artifacts.verify({ job: structuredClone(job), execution: structuredClone(execution), model }); }
                    catch { verified = null; }
                    if (!verified || verified.status === 'UNAVAILABLE') failure = 'ARTIFACT_VERIFICATION_UNAVAILABLE';
                    else if (verified.status === 'INVALID') failure = checkerId(verified.reason) ? verified.reason : 'INVALID_ARTIFACT_EVIDENCE';
                    else if (verified.status !== 'VERIFIED' || !artifactMatches(verified.artifact, execution, job, model)) failure = 'INVALID_ARTIFACT_EVIDENCE';
                    else artifact = JSON.parse(canonicalizeJson(verified.artifact));
                  }
                }
                if (!failure) accepted = { requestId: c.requestId, jobId: job.jobId, eventId: c.eventId, requestPreview: job.requestPreview,
                  logicModelRevision: job.logicModelRevision, logicModelHash: job.logicModelHash, clinicalApprovalId: job.clinicalApprovalId,
                  checkerReportId: job.checkerReportId, checkerInvocationId: job.checkerInvocationId, acceptedWorkflowVersion: job.workflowVersion + 1,
                  outcome: execution.status === 'SUCCEEDED' ? 'COMPILED' : 'FAILED', execution, artifact };
              }
            }
          }
        }
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED','REQUEST_NOT_FOUND');
        const latestActor = await this.#deps.resolveActor(principal, c.requestId);
        if (!latestActor || latestActor.id !== actor.id || !latestActor.roles.includes('COMPILER')) failure = 'IDENTITY_CHANGED';
        else if (!await this.#deps.authorizeRunner(latestActor, job)) failure = 'WORKER_NOT_AUTHORIZED';
        const latest = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (latest?.commandFingerprint === fingerprint && !['IDENTITY_CHANGED','WORKER_NOT_AUTHORIZED'].includes(failure ?? '')) { accepted = await this.#retry(c, latest); failure = undefined; }
        else if (latest && latest.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      }
      const event: WorkflowCommand = accepted?.outcome === 'COMPILED' ? { type: 'COMPILED', eventId: c.eventId, expectedVersion: c.expectedVersion, request: job.requestPreview,
        artifact: { compilationId: job.jobId, logicRevision: job.logicModelRevision, logicHash: job.logicModelHash, artifactHash: accepted.artifact!.packagedObject.sha256 } }
        : { type: 'FAIL', eventId: c.eventId, expectedVersion: c.expectedVersion, request: job.requestPreview, logicRevision: job.logicModelRevision, logicHash: job.logicModelHash,
          compilationId: job.jobId, note: accepted?.execution.errorMessage ?? 'Compilation result could not be accepted.' };
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), expectedActorId: actor.id,
        commandFingerprint: fingerprint, event, ...(accepted ? { compilationResult: accepted } : {}), ...(failure ? { preconditionFailure: failure } : {}),
        ...(execution ? { compilationAttempt: { execution, reason: failure ?? accepted?.execution.failureKind ?? 'COMPILED' } } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return reply(stale(stored.reason) ? 'STALE_VERSION' : blocked(stored.reason) ? 'BLOCKED' : 'REJECTED', stored.reason, stored);
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      if (!receipt) return reply('STORAGE_FAILURE','COMPILATION_RESULT_RECEIPT_INTEGRITY');
      const result = await this.#retry(c, receipt);
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'ACCEPTED', result.outcome === 'COMPILED' ? 'COMPILED' : result.execution.failureKind!, stored, result, receipt);
    } catch { return reply('STORAGE_FAILURE','SERVICE_UNAVAILABLE'); }
  }
}

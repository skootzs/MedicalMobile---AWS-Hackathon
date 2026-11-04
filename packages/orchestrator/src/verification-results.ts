/**
 * VERIFY_BUILD result ingestion. Mirrors CompilationResultService but the
 * authoritative evidence is R6's VerificationReport: R2 fetches the immutable
 * report object by the R7 attempt's reportUri/reportHash, verifies the bytes
 * against reportHash, validates the whole document against R6's published v2.2.0
 * schema, cross-checks the report's echoed references against R2's authoritative
 * identities, and requires passed === true AND coverageComplete === true before
 * emitting the existing VERIFIED transition. A failed/errored/incomplete report,
 * or any integrity failure, emits FAIL (or is rejected). R2 never computes
 * verification outcomes and never fabricates a report.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import type { Actor } from './workflow.ts';
import type { StoreDependencies, ApplyResult, WorkflowCommand } from './storage/requests.ts';
import type { EventReceipt } from './storage/audit.ts';
import type { VerificationResultStore } from './storage/verification-results.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import type { VerifyBuildJobIntent } from './verify-build-contracts.ts';
import {
  parseVerificationExecution, verificationExecutionMatchesJob, verificationResultMatchesJob,
} from './verification-result-contracts.ts';
import type { VerificationExecution, VerificationExecutionSource, VerificationResultRecord } from './verification-result-contracts.ts';
import { validateVerificationReport } from './verification-report-contract.ts';
import type { DurableObjects, ImmutableObjectReference } from './storage/durable-objects.ts';

export interface VerificationResultCommand { requestId: string; jobId: string; eventId: string; expectedVersion: number; attempt: number; executionRecordVersion: string }
export interface VerificationResultDependencies {
  store: VerificationResultStore;
  resolveActor: StoreDependencies['resolveActor'];
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Maps verified R6/R7 service identities; never generic developer access. */
  authorizeRunner(actor: Readonly<Actor>, job: VerifyBuildJobIntent): boolean | Promise<boolean>;
  executions: VerificationExecutionSource;
  /** Immutable object store the report is fetched from and byte-verified against. */
  objects: DurableObjects;
  newAttemptId?: () => string;
}
export interface VerificationIngestionResult {
  status: 'ACCEPTED' | 'DUPLICATE_EVENT' | 'BLOCKED' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string; result: VerificationResultRecord | null; workflowVersion: number | null; auditId: string | null; attemptAuditId: string | null;
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function parse(input: VerificationResultCommand): VerificationResultCommand | null {
  try {
    const c = JSON.parse(canonicalizeJson(input)), fields = ['requestId', 'jobId', 'eventId', 'expectedVersion', 'attempt', 'executionRecordVersion'];
    return c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === fields.length && Object.keys(c).every(k => fields.includes(k)) &&
      [c.requestId, c.jobId, c.eventId, c.executionRecordVersion].every(checkerId) && [c.expectedVersion, c.attempt].every(checkerVersionNumber) ? c : null;
  } catch { return null; }
}
const stale = (r: string) => ['VERSION_CONFLICT', 'STALE_JOB', 'STALE_JOB_ATTEMPT', 'STALE_LOGIC', 'STALE_REQUEST'].includes(r);
const blocked = (r: string) => ['JOB_NOT_COMPLETED', 'REPORT_EVIDENCE_UNAVAILABLE', 'REPORT_UNAVAILABLE'].includes(r);

export class VerificationResultService {
  #deps: VerificationResultDependencies;
  constructor(deps: VerificationResultDependencies) {
    if (typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function' || typeof deps.authorizeRunner !== 'function' ||
        typeof deps.executions?.getCurrent !== 'function' || typeof deps.objects?.read !== 'function' || typeof deps.store?.getVerificationResult !== 'function') throw Error('Trusted runner policy, identity, execution source, object store and result store required.');
    this.#deps = deps;
  }
  async #retry(c: VerificationResultCommand, receipt: EventReceipt): Promise<VerificationResultRecord> {
    const r = await this.#deps.store.getVerificationResult(c.requestId, c.jobId);
    if (!r || r.eventId !== c.eventId || r.execution.attempt !== c.attempt || r.execution.recordVersion !== c.executionRecordVersion ||
        r.execution.jobWorkflowVersion !== c.expectedVersion || !checkerSame(receipt.verificationResult ?? null, r)) throw Error('Verification result receipt integrity failure.');
    return r;
  }
  /** Fetch + byte-verify + schema-validate the R6 report, then cross-check references. */
  async #acceptReport(execution: VerificationExecution, job: VerifyBuildJobIntent, s: { clinicalApproval: { eventId: string } | null; artifact: { artifactHash: string; compilationId: string } | null }):
    Promise<{ record: Omit<VerificationResultRecord, 'requestId' | 'jobId' | 'eventId' | 'acceptedWorkflowVersion' | 'execution'>; passed: boolean } | { failure: string }> {
    if (!execution.reportUri || !execution.reportHash || !execution.reportVersionId) return { failure: 'REPORT_EVIDENCE_UNAVAILABLE' };
    const ref: ImmutableObjectReference = { uri: execution.reportUri, versionId: execution.reportVersionId, sha256: execution.reportHash, size: 1 };
    // readVerified needs a real size; read raw then verify the hash ourselves.
    let bytes: Buffer;
    try { bytes = Buffer.from(await this.#deps.objects.read({ ...ref, size: Number.MAX_SAFE_INTEGER })); }
    catch { return { failure: 'REPORT_UNAVAILABLE' }; }
    if (createHash('sha256').update(bytes).digest('hex') !== execution.reportHash) return { failure: 'REPORT_INTEGRITY' };
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return { failure: 'REPORT_NOT_JSON' }; }
    const validation = validateVerificationReport(parsed);
    if (!validation.ok || !validation.report) return { failure: 'REPORT_SCHEMA_INVALID' };
    const report = validation.report;
    // Cross-check the report's echoed references against R2's authoritative identities.
    const refs = report.references;
    if ((refs.logicModelHash !== null && refs.logicModelHash !== job.logicModelHash) ||
        (refs.clinicalApprovalId !== null && refs.clinicalApprovalId !== job.clinicalApprovalId) ||
        (refs.compilationJobId !== null && refs.compilationJobId !== job.compileJobId) ||
        (refs.packageHash !== null && refs.packageHash !== job.packageHash)) return { failure: 'REPORT_REFERENCE_MISMATCH' };
    // v2.2.0: the top-level packageHash is promoted from references.packageHash;
    // the contract validator already asserts they agree, so a top-level check
    // binds the same authoritative artifact.
    if (report.packageHash !== null && report.packageHash !== job.packageHash) return { failure: 'REPORT_REFERENCE_MISMATCH' };
    // The report must attest to the exact compiled artifact R2 authorized.
    if (report.compileArtifactHash !== job.compileArtifactHash) return { failure: 'REPORT_ARTIFACT_MISMATCH' };
    const passed = report.passed === true && report.coverageComplete === true;
    // A VERIFIED build must carry the authoritative, non-null package hash: a
    // passing report that omits it cannot release. (Failed/incomplete reports
    // may legitimately have a null packageHash and are recorded as FAILED.)
    if (passed && report.packageHash !== job.packageHash) return { failure: 'REPORT_PACKAGE_HASH_REQUIRED' };
    return {
      passed,
      record: {
        requestPreview: job.requestPreview, logicModelRevision: job.logicModelRevision, logicModelHash: job.logicModelHash,
        clinicalApprovalId: job.clinicalApprovalId, compileJobId: job.compileJobId,
        outcome: passed ? 'VERIFIED' : 'FAILED', reportUri: execution.reportUri, reportHash: execution.reportHash,
        reportVersionId: execution.reportVersionId, reportVersion: report.schemaVersion,
        passed: report.passed, coverageComplete: report.coverageComplete,
        testedDirHash: report.testedDirHash, compileArtifactHash: report.compileArtifactHash,
      },
    };
  }
  async ingest(input: VerificationResultCommand, principal: unknown): Promise<VerificationIngestionResult> {
    const c = parse(input);
    const reply = (status: VerificationIngestionResult['status'], reason: string, stored?: ApplyResult, result: VerificationResultRecord | null = null, receipt?: EventReceipt): VerificationIngestionResult => ({
      status, reason, result, workflowVersion: result?.acceptedWorkflowVersion ?? stored?.version ?? null, auditId: receipt?.auditId ?? stored?.auditId ?? null, attemptAuditId: stored?.auditId ?? null,
    });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      const actor: Actor | null = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !checkerId(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      const job = await this.#deps.store.getVerifyBuildJob(c.requestId, c.jobId);
      if (!job) return reply('REJECTED', 'JOB_NOT_FOUND');
      let failure = !actor.roles.includes('VERIFIER') || !await this.#deps.authorizeRunner(actor, job) ? 'WORKER_NOT_AUTHORIZED' : undefined;
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor.id })).digest('hex');
      let accepted: VerificationResultRecord | null = null;
      let execution: VerificationExecution | null = null;
      let passed = false;
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
          else if (s.status !== 'VERIFYING' || s.verificationId !== job.jobId) failure = 'WRONG_STATE';
          else if (s.clinicalApproval?.eventId !== job.clinicalApprovalId) failure = 'CLINICAL_APPROVAL_MISMATCH';
          else if (s.clinicalApproval.actorId === actor.id || s.compilerId === actor.id) failure = 'REVIEWER_NOT_INDEPENDENT';
          else if (!s.artifact || s.artifact.compilationId !== job.compileJobId || s.artifact.artifactHash !== job.packageHash) failure = 'ARTIFACT_MISMATCH';
          else {
            const rawExecution = await this.#deps.executions.getCurrent(c.requestId, c.jobId);
            execution = parseVerificationExecution(rawExecution);
            if (!execution) failure = rawExecution == null ? 'EXECUTION_EVIDENCE_UNAVAILABLE' : 'MALFORMED_EXECUTION_EVIDENCE';
            else if (!verificationExecutionMatchesJob(execution, job)) failure = 'EXECUTION_EVIDENCE_MISMATCH';
            else if (execution.runnerActorId !== actor.id) failure = 'WORKER_NOT_AUTHORIZED';
            else if (execution.attempt !== c.attempt || execution.recordVersion !== c.executionRecordVersion) failure = 'STALE_JOB_ATTEMPT';
            else if (['QUEUED', 'RUNNING'].includes(execution.status)) failure = 'JOB_NOT_COMPLETED';
            else {
              const outcome = await this.#acceptReport(execution, job, s);
              if ('failure' in outcome) failure = outcome.failure;
              else {
                passed = outcome.passed;
                accepted = { requestId: c.requestId, jobId: job.jobId, eventId: c.eventId, acceptedWorkflowVersion: job.workflowVersion + 1, execution, ...outcome.record };
              }
            }
          }
        }
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
        const latestActor = await this.#deps.resolveActor(principal, c.requestId);
        if (!latestActor || latestActor.id !== actor.id || !latestActor.roles.includes('VERIFIER')) failure = 'IDENTITY_CHANGED';
        else if (!await this.#deps.authorizeRunner(latestActor, job)) failure = 'WORKER_NOT_AUTHORIZED';
        const latest = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (latest?.commandFingerprint === fingerprint && !['IDENTITY_CHANGED', 'WORKER_NOT_AUTHORIZED'].includes(failure ?? '')) { accepted = await this.#retry(c, latest); failure = undefined; }
        else if (latest && latest.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      }
      const event: WorkflowCommand = accepted?.outcome === 'VERIFIED'
        ? { type: 'VERIFIED', eventId: c.eventId, expectedVersion: c.expectedVersion, request: job.requestPreview,
            evidence: { compilationId: job.compileJobId, logicRevision: job.logicModelRevision, logicHash: job.logicModelHash,
              artifactHash: job.packageHash, verificationId: job.jobId, reportHash: accepted.reportHash, passed: true } }
        : { type: 'FAIL', eventId: c.eventId, expectedVersion: c.expectedVersion, request: job.requestPreview,
            logicRevision: job.logicModelRevision, logicHash: job.logicModelHash, verificationId: job.jobId,
            note: accepted ? 'Verification did not pass.' : (execution?.errorMessage ?? 'Verification result could not be accepted.') };
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), expectedActorId: actor.id,
        commandFingerprint: fingerprint, event, ...(accepted ? { verificationResult: accepted } : {}), ...(failure ? { preconditionFailure: failure } : {}),
        ...(execution ? { verificationAttempt: { execution, reason: failure ?? (passed ? 'VERIFIED' : 'FAILED') } } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return reply(stale(stored.reason) ? 'STALE_VERSION' : blocked(stored.reason) ? 'BLOCKED' : 'REJECTED', stored.reason, stored);
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      if (!receipt) return reply('STORAGE_FAILURE', 'VERIFICATION_RESULT_RECEIPT_INTEGRITY');
      const result = await this.#retry(c, receipt);
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'ACCEPTED', result.outcome === 'VERIFIED' ? 'VERIFIED' : 'FAILED', stored, result, receipt);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

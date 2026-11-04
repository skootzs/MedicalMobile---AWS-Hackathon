/**
 * VERIFY_BUILD handoff service. Mirrors CompilationHandoffService: it authorizes
 * and records a VERIFY_BUILD job after a successful compilation, emitting the
 * existing START_VERIFICATION transition and committing the job + outbox + audit
 * + receipt atomically via store.apply(). It never runs R6.
 *
 * It binds the EXACT compiled artifact by loading the accepted
 * CompilationResultRecord (where packageHash/manifestHash/compileArtifactHash
 * and the package object URI/version live — they are not in workflow state).
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import type { RevisionIdentity } from './routing.ts';
import type { Actor } from './workflow.ts';
import type { StoreDependencies, ApplyResult } from './storage/requests.ts';
import type { EventReceipt } from './storage/audit.ts';
import type { VerificationResultStore } from './storage/verification-results.ts';
import type { CompilationResultStore } from './storage/compilation-results.ts';
import { checkerId, checkerSame, checkerVersionNumber } from './checker-contracts.ts';
import { createVerifyBuildIntent, validVerifyBuildIntent, toVerifyBuildPayload } from './verify-build-contracts.ts';
import type { VerifyBuildJobIntent } from './verify-build-contracts.ts';
import { validateVerifyBuildPayload } from './r7-handoff-contract.ts';

export interface VerifyBuildCommand extends RevisionIdentity {
  eventId: string;
  expectedVersion: number;
  logicModelRevision: number;
  logicModelHash: string;
  /** The accepted COMPILE_LOGIC job id (== workflow artifact.compilationId). */
  compileJobId: string;
}
export interface VerifyBuildHandoffDependencies {
  /** Needs both VERIFY_BUILD storage and read access to the accepted compilation result. */
  store: VerificationResultStore & CompilationResultStore;
  resolveActor: StoreDependencies['resolveActor'];
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Optional policy may restrict ORCHESTRATOR authority; never elevate other roles. */
  authorizeActor?(actor: Readonly<Actor>, requestId: string): boolean | Promise<boolean>;
  now?: () => string;
  newAttemptId?: () => string;
}
export interface VerifyBuildHandoffResult {
  status: 'INTENT_RECORDED' | 'DUPLICATE_EVENT' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  job: VerifyBuildJobIntent | null;
  workflowVersion: number | null;
  auditId: string | null;
}
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const identity = (c: RevisionIdentity): RevisionIdentity => ({ requestId: c.requestId, revision: c.revision, snapshotHash: c.snapshotHash });
function parse(input: VerifyBuildCommand): VerifyBuildCommand | null {
  try {
    const c = JSON.parse(canonicalizeJson(input));
    const keys = ['requestId', 'eventId', 'expectedVersion', 'revision', 'snapshotHash', 'logicModelRevision', 'logicModelHash', 'compileJobId'];
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== keys.length || Object.keys(c).some(k => !keys.includes(k)) ||
        ![c.requestId, c.eventId, c.compileJobId].every(checkerId) || ![c.expectedVersion, c.revision, c.logicModelRevision].every(checkerVersionNumber) ||
        !hash(c.snapshotHash) || !hash(c.logicModelHash)) return null;
    return c;
  } catch { return null; }
}
export class VerifyBuildHandoffService {
  #deps: VerifyBuildHandoffDependencies;
  constructor(deps: VerifyBuildHandoffDependencies) {
    if (typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function' ||
        typeof deps.store?.getVerifyBuildJob !== 'function' || typeof deps.store?.getCompilationResult !== 'function') throw Error('Trusted identity, access and verify/compilation storage are required.');
    this.#deps = deps;
  }
  async #retry(c: VerifyBuildCommand, receipt: EventReceipt): Promise<VerifyBuildJobIntent> {
    const job = receipt.verifyBuildJobId ? await this.#deps.store.getVerifyBuildJob(c.requestId, receipt.verifyBuildJobId) : null;
    if (!job || job.handoffEventId !== c.eventId || job.sourceWorkflowVersion !== c.expectedVersion || receipt.workflowVersion !== job.workflowVersion ||
        !checkerSame(receipt.request, identity(c)) || !checkerSame(job.requestPreview, identity(c)) || job.logicModelRevision !== c.logicModelRevision ||
        job.logicModelHash !== c.logicModelHash || job.compileJobId !== c.compileJobId) throw Error('Verify-build receipt integrity failure.');
    return job;
  }
  async start(input: VerifyBuildCommand, principal: unknown): Promise<VerifyBuildHandoffResult> {
    const c = parse(input);
    const reply = (status: VerifyBuildHandoffResult['status'], reason: string, stored?: ApplyResult, job: VerifyBuildJobIntent | null = null): VerifyBuildHandoffResult => ({
      status, reason, job, workflowVersion: job?.workflowVersion ?? stored?.version ?? null, auditId: stored?.auditId ?? null,
    });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      const actor: Actor | null = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !checkerId(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      let failure = !actor.roles.includes('ORCHESTRATOR') || this.#deps.authorizeActor && await this.#deps.authorizeActor(actor, c.requestId) !== true ? 'WRONG_ROLE' : undefined;
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor.id })).digest('hex');
      let job: VerifyBuildJobIntent | null = null;
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
          else if (s.status !== 'WAITING_FOR_VERIFICATION') failure = 'WRONG_STATE';
          else if (!s.artifact || s.artifact.compilationId !== c.compileJobId) failure = 'ARTIFACT_MISMATCH';
          else if (!s.clinicalApproval) failure = 'CLINICAL_APPROVAL_REQUIRED';
          else if (!s.checks?.reportId) failure = 'CHECKER_EVIDENCE_REQUIRED';
          else {
            // Bind the EXACT compiled artifact: packageHash/manifestHash/compileArtifactHash + object URI live in the accepted result.
            const result = await this.#deps.store.getCompilationResult(c.requestId, c.compileJobId);
            if (!result || result.outcome !== 'COMPILED' || !result.artifact) failure = 'COMPILATION_RESULT_REQUIRED';
            else if (result.artifact.packagedObject.sha256 !== s.artifact.artifactHash) failure = 'ARTIFACT_MISMATCH';
            else {
              const snapshotUri = `s3://r2/snapshots/${s.logic.logicHash}.json`;
              job = createVerifyBuildIntent({
                requestId: c.requestId, revision: c.revision, requestPreview: identity(c),
                logicModelRevision: c.logicModelRevision, logicModelHash: s.logic.logicHash,
                clinicalApprovalId: s.clinicalApproval.eventId, compileJobId: c.compileJobId,
                packageHash: result.artifact.packagedObject.sha256, packageUri: result.artifact.packagedObject.uri,
                packageVersionId: result.artifact.packagedObject.versionId, manifestHash: result.artifact.manifest.sha256,
                compileArtifactHash: result.artifact.generatedFilesHash, snapshotUri,
                checkerReportId: s.checks.reportId, sourceWorkflowVersion: s.version,
                handoffEventId: c.eventId, createdBy: actor.id, createdAt: (this.#deps.now ?? (() => new Date().toISOString()))(),
              });
              // Fail closed if the outgoing payload would not satisfy R7's published schema.
              if (!validVerifyBuildIntent(job)) { job = null; failure = 'VERIFY_BUILD_INTENT_REQUIRED'; }
              else {
                const payload = validateVerifyBuildPayload(toVerifyBuildPayload(job));
                if (!payload.ok) { job = null; failure = 'R7_PAYLOAD_INVALID'; }
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
      if (!job && !failure) failure = 'VERIFY_BUILD_INTENT_REQUIRED';
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), expectedActorId: actor.id,
        commandFingerprint: fingerprint, event: { type: 'START_VERIFICATION', eventId: c.eventId, expectedVersion: c.expectedVersion,
          request: identity(c), verificationId: job?.jobId ?? 'not-authorized' }, ...(job ? { verifyBuildIntent: job } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return reply(['VERSION_CONFLICT', 'STALE_REQUEST', 'STALE_LOGIC'].includes(stored.reason) ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      if (!receipt) return reply('STORAGE_FAILURE', 'VERIFY_BUILD_RECEIPT_INTEGRITY');
      const saved = await this.#retry(c, receipt);
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'INTENT_RECORDED', stored.reason, { ...stored, auditId: receipt.auditId }, saved);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

import { parseCompilationExecution, resultMatchesJob } from '../compilation-result-contracts.ts';
import type { CompilationResultRecord, CompilationExecution } from '../compilation-result-contracts.ts';
import type { CompilationResultStore } from './compilation-results.ts';
import { compilationOutbox, validCompilationIntent } from '../compilation-contracts.ts';
import type { CompilationJobIntent, CompilationOutbox } from '../compilation-contracts.ts';
import { compilationEvidenceFailure } from '../compilation-eligibility.ts';
import type { CompilationStore } from './compilations.ts';
import { createHash } from 'node:crypto';
import { checkerSame, checkerEvidenceMatches, validInvocation, validCheckerResult, parseCheckerReport } from '../checker-contracts.ts';
import type { CheckerInvocation, AcceptedCheckerResult } from '../checker-contracts.ts';
import type { CheckerStore, AuthorizeCheckerInput } from './checkers.ts';
import { validationMatches, validationReference } from '../callback-contracts.ts';
import type { DraftingResultRecord } from '../callback-contracts.ts';
import type { DraftingResultStore } from './drafting-results.ts';
import { createDraftingIntent } from '../job-intents.ts';
import type { DraftingJobIntent } from '../job-intents.ts';
import type { JobStore, JobDeliveryAttempt } from './jobs.ts';
import { canonicalizeJson } from '../snapshots.ts';
import type { Snapshot } from '../snapshots.ts';
import { transitionWorkflow } from '../workflow.ts';
import type { Actor, ProposedAuditEvent, WorkflowEvent, WorkflowState } from '../workflow.ts';
import { evidenceFromEvent } from './artifacts.ts';
import type { EvidenceRecord } from './artifacts.ts';
import type { AuditRecord, EventReceipt } from './audit.ts';
import { StorageError } from './requests.ts';
import type { ApplyCommand, ApplyResult, OrchestratorStore, ReviewCandidateSource, SnapshotKey, StoreDependencies, WorkflowCommand } from './requests.ts';
import { snapshotKey, snapshotSlot, verifySnapshot } from './snapshots.ts';

interface Attempt { fingerprint: string; result: ApplyResult }
interface MemoryData {
  workflows: Map<string, WorkflowState>;
  compilationJobs: Map<string, CompilationJobIntent>;
  compilationResults: Map<string, CompilationResultRecord>;
  compilationOutboxes: Map<string, CompilationOutbox>;
  jobs: Map<string, DraftingJobIntent>;
  draftingResults: Map<string, DraftingResultRecord>;
  checkerInvocations: Map<string, CheckerInvocation>;
  checkerReports: Map<string, AcceptedCheckerResult>;
  checkerEventFingerprints: Map<string, string>;
  snapshots: Map<string, string>;
  receipts: Map<string, EventReceipt>;
  evidence: Map<string, EvidenceRecord>;
  audits: Map<string, readonly AuditRecord[]>;
  attempts: Map<string, Attempt>;
}
/** Internal trusted persistence image, never a browser import/export contract. */
export interface RepositoryImage {
  format: 'r2-repository-image-v1';
  collections: Record<string, readonly (readonly [string, unknown])[]>;
}
export interface InMemoryOptions extends StoreDependencies {
  /** Local synchronous conditional read against the injected authoritative R7 test source.
   * Real DynamoDB adapter MUST condition JOB/META record version/attempt in its transaction. */
  compilationExecutionIsCurrent?(expected: Readonly<CompilationExecution>): boolean;
  /** Fault injection for tests only; real adapters must not expose these hooks. */
  testFaults?: {
    beforeCommit?: () => void;
    readSnapshotBytes?: (bytes: string) => string;
  };
}
const key = (...parts: string[]) => JSON.stringify(parts);
const id = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim() === v;
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const identity = (state: WorkflowState) => ({ requestId: state.brief.requestId, revision: state.brief.revision, snapshotHash: state.brief.snapshotHash });

/**
 * Local single-process fake. All mutation after actor resolution is synchronous,
 * staged in replacement Maps, then committed by one pointer assignment. No awaits
 * occur in that section. This is NOT distributed/durable database atomicity.
 */
export class InMemoryOrchestratorStore implements OrchestratorStore, ReviewCandidateSource, JobStore, DraftingResultStore, CheckerStore, CompilationStore, CompilationResultStore {
  #data: MemoryData = { workflows: new Map(), compilationJobs: new Map(), compilationResults: new Map(), compilationOutboxes: new Map(), jobs: new Map(), draftingResults: new Map(), checkerInvocations: new Map(), checkerReports: new Map(), checkerEventFingerprints: new Map(), snapshots: new Map(), receipts: new Map(), evidence: new Map(), audits: new Map(), attempts: new Map() };
  #options: InMemoryOptions;
  constructor(options: InMemoryOptions) {
    if (typeof options.resolveActor !== 'function' || typeof options.validateSnapshot !== 'function') throw new StorageError('MISSING_BACKEND_BOUNDARY');
    this.#options = options;
  }
  /** Stateless durable-adapter planning bridge; all guards below remain unchanged. */
  exportRepositoryImage(): RepositoryImage {
    return structuredClone({ format: 'r2-repository-image-v1', collections: Object.fromEntries(Object.entries(this.#data).map(([name, map]) => [name, [...map]])) });
  }
  static restoreRepositoryImage(options: InMemoryOptions, image: RepositoryImage): InMemoryOrchestratorStore {
    const store = new InMemoryOrchestratorStore(options);
    const copy = JSON.parse(canonicalizeJson(image)) as RepositoryImage;
    const names = Object.keys(store.#data).sort();
    if (copy.format !== 'r2-repository-image-v1' || !copy.collections || canonicalizeJson(Object.keys(copy.collections).sort()) !== canonicalizeJson(names)) throw new StorageError('INVALID_REPOSITORY_IMAGE');
    const restored: Record<string, Map<string, unknown>> = {};
    for (const name of names) {
      const entries = copy.collections[name];
      if (!Array.isArray(entries) || entries.some(e => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') || new Set(entries.map(e => e[0])).size !== entries.length) throw new StorageError('INVALID_REPOSITORY_IMAGE');
      restored[name] = new Map(entries);
    }
    store.#data = restored as unknown as MemoryData;
    return store;
  }
  #decode(slot: string, bytes: string): Snapshot {
    try {
      const loaded = this.#options.testFaults?.readSnapshotBytes?.(bytes) ?? bytes;
      const snapshot = verifySnapshot(JSON.parse(loaded), this.#options.validateSnapshot);
      // We write canonical bytes. Reject ambiguous duplicate keys or other byte
      // changes that JSON.parse alone could discard before hash verification.
      if (canonicalizeJson(snapshot) !== loaded) throw new StorageError('SNAPSHOT_INTEGRITY');
      if (snapshotSlot(snapshotKey(snapshot)) !== slot) throw new StorageError('SNAPSHOT_INTEGRITY');
      return snapshot;
    } catch { throw new StorageError('SNAPSHOT_INTEGRITY'); }
  }
  #readSnapshot(snapshots: Map<string, string>, ref: SnapshotKey): Snapshot | null {
    const slot = snapshotSlot(ref), bytes = snapshots.get(slot);
    return bytes === undefined ? null : this.#decode(slot, bytes);
  }
  #assertSnapshots(state: WorkflowState, snapshots: Map<string, string>) {
    const previewKey: SnapshotKey = { kind: 'REQUEST_PREVIEW', requestId: state.brief.requestId, revision: state.brief.revision };
    const preview = this.#readSnapshot(snapshots, previewKey);
    if (!preview || preview.snapshotHash !== state.brief.snapshotHash) throw new StorageError('SNAPSHOT_REQUIRED');
    const { requestId, revision, snapshotHash, ...content } = state.brief;
    if (canonicalizeJson(content) !== canonicalizeJson(preview.content)) throw new StorageError('REQUEST_CONTENT_MISMATCH');
    const requiredSlots = new Set([snapshotSlot(previewKey)]);
    if (state.logic) {
      const logicKey: SnapshotKey = { kind: 'LOGIC_MODEL', requestId, revision: state.logic.logicRevision, requestPreview: identity(state) };
      const logic = this.#readSnapshot(snapshots, logicKey);
      if (!logic || logic.snapshotHash !== state.logic.logicHash) throw new StorageError('SNAPSHOT_REQUIRED');
      requiredSlots.add(snapshotSlot(logicKey));
    }
    return requiredSlots;
  }
  async listReviewCandidates(status: WorkflowState['status']): Promise<readonly string[]> {
    // Discovery only; the review service must re-read, authorize and check evidence.
    return [...this.#data.workflows].filter(([, state]) => state.status === status).map(([id]) => id).sort();
  }
  async getWorkflow(requestId: string): Promise<WorkflowState | null> {
    const state = this.#data.workflows.get(requestId);
    if (!state) return null;
    this.#assertSnapshots(state, this.#data.snapshots);
    return structuredClone(state);
  }
  async getSnapshot(ref: SnapshotKey): Promise<Snapshot | null> { return this.#readSnapshot(this.#data.snapshots, ref); }
  async listSnapshots(requestId: string): Promise<readonly Snapshot[]> {
    const result: Snapshot[] = [];
    for (const [slot, bytes] of this.#data.snapshots) {
      // Slots are internal composite keys, not filesystem paths or caller JSON.
      if ((JSON.parse(slot) as unknown[])[0] === requestId) result.push(this.#decode(slot, bytes));
    }
    return result;
  }
  async getReceipt(requestId: string, eventId: string): Promise<EventReceipt | null> {
    const receipt = this.#data.receipts.get(key(requestId, eventId));
    if (!receipt) return null;
    const snapshot = this.#readSnapshot(this.#data.snapshots, { kind: 'REQUEST_PREVIEW', requestId, revision: receipt.request.revision });
    if (!snapshot || snapshot.snapshotHash !== receipt.request.snapshotHash) throw new StorageError('SNAPSHOT_INTEGRITY');
    return structuredClone(receipt);
  }
  async listEvidence(requestId: string): Promise<readonly EvidenceRecord[]> {
    const records = [...this.#data.evidence.values()].filter(record => record.requestId === requestId);
    for (const record of records) {
      const { event } = record;
      const preview = this.#readSnapshot(this.#data.snapshots, { kind: 'REQUEST_PREVIEW', requestId, revision: event.request.revision });
      if (!preview || preview.snapshotHash !== event.request.snapshotHash) throw new StorageError('SNAPSHOT_INTEGRITY');
      const logic = event.type === 'COMPILED' ? event.artifact
        : event.type === 'VERIFIED' || event.type === 'RELEASE_DECISION' ? event.evidence
        : event.type === 'LOGIC_CHECKED' || event.type === 'CLINICAL_DECISION' ? event : null;
      if (logic) {
        const snapshot = this.#readSnapshot(this.#data.snapshots, { kind: 'LOGIC_MODEL', requestId,
          revision: logic.logicRevision, requestPreview: event.request });
        if (!snapshot || snapshot.snapshotHash !== logic.logicHash) throw new StorageError('SNAPSHOT_INTEGRITY');
      }
      if (event.type === 'COMPILED' && record.compilationResult !== undefined) {
        const result = await this.getCompilationResult(requestId, event.artifact.compilationId);
        if (!result || !checkerSame(result, record.compilationResult) || result.eventId !== event.eventId || result.artifact?.packagedObject.sha256 !== event.artifact.artifactHash) throw new StorageError('COMPILATION_RESULT_INTEGRITY');
      }
      if (event.type === 'LOGIC_CHECKED' && (event.invocationId !== undefined || record.checkerResult !== undefined)) {
        const result = await this.getCheckerReport(requestId, event.reportId);
        if (!result || !checkerSame(result, record.checkerResult) || !checkerEvidenceMatches(result, { request: event.request,
          logic: { logicRevision: event.logicRevision, logicHash: event.logicHash }, reportId: event.reportId, eventId: event.eventId,
          invocationId: event.invocationId, passed: event.passed, actorId: event.actor.id })) throw new StorageError('CHECKER_REPORT_INTEGRITY');
      }
    }
    return structuredClone(records);
  }
  async listAudit(requestId: string): Promise<readonly AuditRecord[]> { return structuredClone(this.#data.audits.get(requestId) ?? []); }

  async getJob(requestId: string, jobId: string): Promise<DraftingJobIntent | null> {
    const job = this.#data.jobs.get(key(requestId, jobId));
    if (!job) return null;
    const preview = this.#readSnapshot(this.#data.snapshots, { kind: 'REQUEST_PREVIEW', requestId, revision: job.requestPreview.revision });
    const handoff = this.#data.receipts.get(key(requestId, job.handoffEventId));
    const route = this.#data.receipts.get(key(requestId, job.routingEventId));
    if (job.requestId !== requestId || job.jobId !== jobId || job.requestPreview.requestId !== requestId ||
        !preview || preview.snapshotHash !== job.requestPreview.snapshotHash || !handoff || handoff.jobId !== jobId ||
        handoff.workflowVersion !== job.workflowVersion || canonicalizeJson(handoff.request) !== canonicalizeJson(job.requestPreview) ||
        !route || route.routing?.route !== 'READY_FOR_BEDROCK_REVIEW' || route.workflowVersion !== job.sourceWorkflowVersion ||
        canonicalizeJson(route.request) !== canonicalizeJson(job.requestPreview) ||
        canonicalizeJson(createDraftingIntent(job.requestPreview, job.sourceWorkflowVersion, job.routingEventId, job.handoffEventId)) !== canonicalizeJson(job)) throw new StorageError('JOB_INTEGRITY');
    return structuredClone(job);
  }
  async listJobs(requestId: string): Promise<readonly DraftingJobIntent[]> {
    const jobs: DraftingJobIntent[] = [];
    for (const j of this.#data.jobs.values()) if (j.requestId === requestId) jobs.push((await this.getJob(requestId, j.jobId))!);
    return jobs;
  }
  async getDraftingResult(requestId: string, jobId: string): Promise<DraftingResultRecord | null> {
    const result = this.#data.draftingResults.get(key(requestId, jobId));
    if (!result) return null;
    const job = await this.getJob(requestId, jobId);
    const receipt = this.#data.receipts.get(key(requestId, result.eventId));
    const model = this.#readSnapshot(this.#data.snapshots, { kind: 'LOGIC_MODEL', requestId, revision: result.logic.logicRevision, requestPreview: result.requestPreview });
    if (!job || result.requestId !== requestId || result.jobId !== jobId || result.sourceWorkflowVersion !== job.sourceWorkflowVersion ||
        result.jobWorkflowVersion !== job.workflowVersion || result.acceptedWorkflowVersion !== job.workflowVersion + 1 || result.handoffEventId !== job.handoffEventId ||
        canonicalizeJson(result.requestPreview) !== canonicalizeJson(job.requestPreview) || !receipt || receipt.workflowVersion !== result.acceptedWorkflowVersion ||
        canonicalizeJson(receipt.request) !== canonicalizeJson(result.requestPreview) || canonicalizeJson(receipt.draftingResult ?? null) !== canonicalizeJson(result) ||
        !model || model.snapshotHash !== result.logic.logicHash || !validationMatches(result.validation, model)) throw new StorageError('DRAFTING_RESULT_INTEGRITY');
    return structuredClone(result);
  }
  async getCompilationResult(requestId: string, jobId: string): Promise<CompilationResultRecord | null> {
    const result = this.#data.compilationResults.get(key(requestId, jobId));
    if (!result) return null;
    const job = await this.getCompilationJob(requestId, jobId);
    const model = job ? this.#readSnapshot(this.#data.snapshots, { kind: 'LOGIC_MODEL', requestId, revision: job.logicModelRevision, requestPreview: job.requestPreview }) : null;
    const receipt = this.#data.receipts.get(key(requestId, result.eventId));
    if (!job || !model || model.kind !== 'LOGIC_MODEL' || !resultMatchesJob(result, job, model) || !receipt ||
        !checkerSame(receipt.compilationResult ?? null, result) || receipt.workflowVersion !== result.acceptedWorkflowVersion) throw new StorageError('COMPILATION_RESULT_INTEGRITY');
    return structuredClone(result);
  }
  async getCompilationJob(requestId: string, jobId: string): Promise<CompilationJobIntent | null> {
    const job = this.#data.compilationJobs.get(key(requestId, jobId));
    if (!job) return null;
    const snapshot = this.#readSnapshot(this.#data.snapshots, { kind: 'LOGIC_MODEL', requestId,
      revision: job.logicModelRevision, requestPreview: job.requestPreview });
    const receipt = this.#data.receipts.get(key(requestId, job.handoffEventId));
    const audit = (this.#data.audits.get(requestId) ?? []).find(a => a.auditId === receipt?.auditId);
    const outbox = this.#data.compilationOutboxes.get(key(requestId, jobId));
    if (!snapshot || snapshot.kind !== 'LOGIC_MODEL' || !validCompilationIntent(job, snapshot) || job.requestId !== requestId || job.jobId !== jobId ||
        !receipt || receipt.compilationJobId !== jobId || receipt.workflowVersion !== job.workflowVersion || !checkerSame(receipt.request, job.requestPreview) ||
        !audit || audit.outcome !== 'ACCEPTED' || !checkerSame(audit.compilationIntent ?? null, job) || !checkerSame(outbox ?? null, compilationOutbox(job))) throw new StorageError('COMPILATION_JOB_INTEGRITY');
    return structuredClone(job);
  }
  async listCompilationJobs(requestId: string): Promise<readonly CompilationJobIntent[]> {
    const result: CompilationJobIntent[] = [];
    for (const job of this.#data.compilationJobs.values()) if (job.requestId === requestId) result.push((await this.getCompilationJob(requestId, job.jobId))!);
    return result;
  }
  async getCompilationOutbox(requestId: string, jobId: string): Promise<CompilationOutbox | null> {
    const outbox = this.#data.compilationOutboxes.get(key(requestId, jobId));
    if (!outbox) return null;
    const job = await this.getCompilationJob(requestId, jobId);
    if (!job) throw new StorageError('COMPILATION_OUTBOX_INTEGRITY');
    return structuredClone(outbox);
  }
  async getCheckerInvocation(requestId: string, invocationId: string): Promise<CheckerInvocation | null> {
    const invocation = this.#data.checkerInvocations.get(key(requestId, invocationId));
    if (!invocation) return null;
    const receipt = this.#data.receipts.get(key(requestId, invocation.eventId));
    const model = this.#readSnapshot(this.#data.snapshots, { kind: 'LOGIC_MODEL', requestId, revision: invocation.logic.logicRevision, requestPreview: invocation.requestPreview });
    if (!validInvocation(invocation) || invocation.requestId !== requestId || !receipt || !checkerSame(receipt.checkerInvocation ?? null, invocation) ||
        receipt.workflowVersion !== invocation.workflowVersion || !checkerSame(receipt.request, invocation.requestPreview) || !model || model.snapshotHash !== invocation.logic.logicHash) throw new StorageError('CHECKER_INVOCATION_INTEGRITY');
    return structuredClone(invocation);
  }
  async getCheckerReport(requestId: string, reportId: string): Promise<AcceptedCheckerResult | null> {
    const result = this.#data.checkerReports.get(key(requestId, reportId));
    if (!result) return null;
    const invocation = await this.getCheckerInvocation(requestId, result.invocation.invocationId);
    const receipt = this.#data.receipts.get(key(requestId, result.eventId));
    if (!validCheckerResult(result) || result.report.requestId !== requestId || result.report.reportId !== reportId || !invocation || !checkerSame(invocation, result.invocation) ||
        !receipt || !checkerSame(receipt.checkerResult ?? null, result) || receipt.workflowVersion !== result.workflowVersion || !checkerSame(receipt.request, invocation.requestPreview)) throw new StorageError('CHECKER_REPORT_INTEGRITY');
    return structuredClone(result);
  }
  async authorizeChecker(input: AuthorizeCheckerInput, principal: unknown): Promise<ApplyResult> {
    let command: AuthorizeCheckerInput;
    try { command = JSON.parse(canonicalizeJson(input)); } catch { throw new StorageError('INVALID_COMMAND'); }
    if (!obj(command) || !id(command.requestId) || !id(command.attemptId) || !validInvocation(command.invocation) || command.invocation.requestId !== command.requestId ||
        Object.keys(command).some(k => !['requestId', 'attemptId', 'invocation', 'expectedActorId'].includes(k)) || command.expectedActorId !== undefined && !id(command.expectedActorId)) throw new StorageError('INVALID_COMMAND');
    let actor: Actor | null;
    try { actor = structuredClone(await this.#options.resolveActor(principal, command.requestId)); } catch { actor = null; }
    // Atomic metadata authorization, not a second workflow state machine.
    const base = this.#data, state = base.workflows.get(command.requestId) ?? null, invocation = command.invocation;
    const fingerprint = canonicalizeJson({ command, actor });
    const commandFingerprint = createHash('sha256').update(canonicalizeJson({ invocation, actorId: actor?.id ?? null })).digest('hex');
    const prior = base.attempts.get(key(command.requestId, command.attemptId));
    if (prior) { if (prior.fingerprint !== fingerprint) throw new StorageError('ATTEMPT_ID_REUSED'); return { ...structuredClone(prior.result), replayed: true }; }
    let reason = 'CHECKER_AUTHORIZED';
    let outcome: ApplyResult['outcome'] = 'ACCEPTED';
    if (!actor) reason = 'UNAUTHORIZED';
    else if (!actor.roles.includes('ORCHESTRATOR')) reason = 'WRONG_ROLE';
    else if (command.expectedActorId !== undefined && command.expectedActorId !== actor.id) reason = 'IDENTITY_CHANGED';
    else {
      if (state) this.#assertSnapshots(state, base.snapshots);
      const receipt = base.receipts.get(key(command.requestId, invocation.eventId));
      if (receipt) {
        if (receipt.commandFingerprint === commandFingerprint && checkerSame(receipt.checkerInvocation ?? null, invocation)) { reason = 'ALREADY_AUTHORIZED'; outcome = 'DUPLICATE'; }
        else reason = 'EVENT_ID_REUSED';
      } else if (!state) reason = 'REQUEST_NOT_FOUND';
      else if (state.version !== invocation.workflowVersion) reason = 'VERSION_CONFLICT';
      else if (!checkerSame(identity(state), invocation.requestPreview) || !checkerSame(state.logic, invocation.logic)) reason = 'STALE_LOGIC';
      else if (state.status !== 'WAITING_FOR_LOGIC_CHECKS') reason = 'WRONG_STATE';
      else if ([...base.checkerInvocations.values()].some(old => old.requestId === command.requestId && checkerSame(old.requestPreview, invocation.requestPreview) && checkerSame(old.logic, invocation.logic))) reason = 'CHECKER_INVOCATION_ALREADY_EXISTS';
    }
    if (!['CHECKER_AUTHORIZED', 'ALREADY_AUTHORIZED'].includes(reason)) outcome = 'REJECTED';
    const audit: ProposedAuditEvent = { eventId: invocation.eventId, requestId: command.requestId, actorId: actor?.id ?? null,
      outcome, reason, from: state?.status ?? null, to: state?.status ?? null, stateVersion: state?.version ?? 0, eventType: 'AUTHORIZE_LOGIC_CHECK',
      note: null, attemptedRequest: invocation.requestPreview, request: state ? identity(state) : null, logic: state?.logic ? { ...state.logic } : null, artifactHash: null };
    const update = this.#append(base, command, fingerprint, audit, !actor, outcome === 'ACCEPTED' ? { checkerInvocation: invocation } : {});
    if (outcome === 'ACCEPTED') {
      const candidate = { ...update.data, checkerInvocations: new Map(base.checkerInvocations), receipts: new Map(base.receipts) };
      candidate.checkerInvocations.set(key(command.requestId, invocation.invocationId), structuredClone(invocation));
      candidate.receipts.set(key(command.requestId, invocation.eventId), { request: invocation.requestPreview, eventId: invocation.eventId,
        fingerprint: commandFingerprint, commandFingerprint, workflowVersion: invocation.workflowVersion, auditId: update.result.auditId, checkerInvocation: structuredClone(invocation) });
      this.#commit(candidate);
    } else this.#commit(update.data);
    return structuredClone(update.result);
  }
  async recordJobDelivery(input: JobDeliveryAttempt, principal: unknown): Promise<ApplyResult> {
    // Internal, append-only transport audit. No workflow transition, worker call or job mutation.
    let attempt: JobDeliveryAttempt;
    try { attempt = JSON.parse(canonicalizeJson(input)) as JobDeliveryAttempt; } catch { throw new StorageError('INVALID_COMMAND'); }
    if (!obj(attempt) || !id(attempt.requestId) || !id(attempt.jobId) || !id(attempt.attemptId) ||
        !Number.isSafeInteger(attempt.expectedVersion) || attempt.expectedVersion < 1 ||
        !['ACCEPTED', 'DUPLICATE', 'FAILED', 'UNAVAILABLE', 'NOT_ATTEMPTED'].includes(attempt.outcome) ||
        (attempt.expectedActorId !== undefined && !id(attempt.expectedActorId)) ||
        (attempt.preconditionFailure !== undefined && !id(attempt.preconditionFailure)) ||
        Object.keys(attempt).some(k => !['requestId', 'jobId', 'attemptId', 'expectedVersion', 'outcome', 'expectedActorId', 'preconditionFailure'].includes(k))) throw new StorageError('INVALID_COMMAND');
    let actor: Actor | null;
    try { actor = structuredClone(await this.#options.resolveActor(principal, attempt.requestId)); } catch { actor = null; }
    const base = this.#data, state = base.workflows.get(attempt.requestId) ?? null;
    const job = base.jobs.get(key(attempt.requestId, attempt.jobId));
    const fingerprint = canonicalizeJson({ attempt, actor });
    const prior = base.attempts.get(key(attempt.requestId, attempt.attemptId));
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new StorageError('ATTEMPT_ID_REUSED');
      return { ...structuredClone(prior.result), replayed: true };
    }
    let failure: string | undefined;
    if (!actor) failure = 'UNAUTHORIZED';
    else if (!actor.roles.includes('ORCHESTRATOR')) failure = 'WRONG_ROLE';
    else if (attempt.expectedActorId !== undefined && attempt.expectedActorId !== actor.id) failure = 'IDENTITY_CHANGED';
    else if (!state || !job) failure = 'JOB_NOT_FOUND';
    else {
      this.#assertSnapshots(state, base.snapshots);
      if (state.version !== attempt.expectedVersion || state.version !== job.workflowVersion) failure = 'VERSION_CONFLICT';
      else if (canonicalizeJson(identity(state)) !== canonicalizeJson(job.requestPreview)) failure = 'STALE_REQUEST';
      else if (state.status !== 'DRAFTING_LOGIC') failure = 'WRONG_STATE';
    }
    failure ??= attempt.preconditionFailure;
    const accepted = !failure && ['ACCEPTED', 'DUPLICATE'].includes(attempt.outcome);
    const reason = failure ?? (attempt.outcome === 'NOT_ATTEMPTED' ? 'DELIVERY_NOT_ATTEMPTED' : `WORKER_${attempt.outcome}`);
    const audit: ProposedAuditEvent = { eventId: attempt.attemptId, requestId: attempt.requestId, actorId: actor?.id ?? null,
      outcome: accepted ? 'ACCEPTED' : 'REJECTED', reason, from: state?.status ?? null, to: state?.status ?? null,
      stateVersion: state?.version ?? 0, eventType: 'DELIVER_DRAFTING_JOB', note: null,
      attemptedRequest: job ? { ...job.requestPreview } : null, request: state ? identity(state) : null,
      logic: state?.logic ? { ...state.logic } : null, artifactHash: state?.artifact?.artifactHash ?? null };
    const update = this.#append(base, attempt, fingerprint, audit, !actor,
      { jobDelivery: { jobId: attempt.jobId, outcome: attempt.outcome } });
    this.#commit(update.data); return structuredClone(update.result);
  }
  #commit(candidate: MemoryData) {
    try {
      const returned = this.#options.testFaults?.beforeCommit?.();
      if (returned !== undefined) throw new Error('Synchronous fault hook required.');
    } catch { throw new StorageError('TRANSACTION_FAILED'); }
    this.#data = candidate;
  }
  #append(base: MemoryData, command: Pick<ApplyCommand, 'requestId' | 'attemptId'> & { event?: WorkflowCommand }, fingerprint: string, audit: ProposedAuditEvent, hiddenVersion = false, attachment: Pick<AuditRecord, 'jobIntent' | 'jobDelivery' | 'draftingResult' | 'callbackValidation' | 'checkerInvocation' | 'checkerResult' | 'checkerAttempt' | 'compilationIntent' | 'compilationOutbox' | 'compilationResult'> = {}): { data: MemoryData; result: ApplyResult } {
    const auditId = key(command.requestId, command.attemptId);
    if (base.attempts.has(auditId)) throw new StorageError('ATTEMPT_ID_REUSED');
    const recordedAt = (this.#options.now ?? (() => new Date().toISOString()))();
    if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) throw new StorageError('INVALID_CLOCK');
    const history = base.audits.get(command.requestId) ?? [];
    const record: AuditRecord = { ...structuredClone(audit), auditId, sequence: history.length + 1, recordedAt, ...structuredClone(attachment),
      ...(command.event?.type === 'LOGIC_CHECKED' && 'checkerAttempt' in command && parseCheckerReport(command.checkerAttempt) ? { checkerAttempt: parseCheckerReport(command.checkerAttempt)! } : {}),
      ...(command.event?.type === 'LOGIC_PROPOSED' && 'callbackValidation' in command && validationReference(command.callbackValidation) ? { callbackValidation: validationReference(command.callbackValidation)! } : {}),
      ...(audit.outcome === 'ACCEPTED' && command.event?.type === 'APPLY_ROUTING' ? { routing: structuredClone(command.event.result) } : {}) };
    if (command.event && 'compilationAttempt' in command && command.compilationAttempt && typeof command.compilationAttempt === 'object') {
      const attempt = command.compilationAttempt as { execution: unknown; reason: unknown };
      const execution = parseCompilationExecution(attempt.execution);
      if (execution && execution.requestId === command.requestId && id(attempt.reason)) record.compilationAttempt = { execution, reason: attempt.reason };
    }
    const result: ApplyResult = { outcome: audit.outcome, reason: audit.reason, version: hiddenVersion ? null : audit.stateVersion, auditId, replayed: false };
    const data = { ...base, audits: new Map(base.audits), attempts: new Map(base.attempts), checkerEventFingerprints: new Map(base.checkerEventFingerprints) };
    // Bind a well-formed checker event even when it reports unavailable/incomplete.
    // A changed report needs a new event ID; retries may repeat the exact payload.
    if (command.event?.type === 'LOGIC_CHECKED' && 'commandFingerprint' in command && typeof command.commandFingerprint === 'string' &&
        'checkerAttempt' in command && parseCheckerReport(command.checkerAttempt) &&
        ['CHECKER_UNAVAILABLE', 'CHECKER_INCOMPLETE'].includes(audit.reason)) {
      const slot = key(command.requestId, command.event.eventId);
      if (!data.checkerEventFingerprints.has(slot)) data.checkerEventFingerprints.set(slot, command.commandFingerprint);
    }
    data.audits.set(command.requestId, [...history, record]);
    data.attempts.set(auditId, { fingerprint, result: structuredClone(result) });
    return { data, result };
  }
  #rejection(state: WorkflowState | null, command: ApplyCommand, actor: Actor | null, reason: string): ProposedAuditEvent {
    const event: Record<string, unknown> = obj(command.event) ? command.event : {};
    return { eventId: id(event.eventId) ? event.eventId : '(invalid)', requestId: command.requestId,
      actorId: actor && id(actor.id) ? actor.id : null, outcome: 'REJECTED', reason,
      from: state?.status ?? null, to: state?.status ?? null, stateVersion: state?.version ?? 0,
      eventType: typeof event.type === 'string' ? event.type : '(invalid)', note: null,
      attemptedRequest: null, request: state ? identity(state) : null,
      logic: state?.logic ? { ...state.logic } : null, artifactHash: state?.artifact?.artifactHash ?? null };
  }
  async apply(input: ApplyCommand, principal: unknown): Promise<ApplyResult> {
    if (!obj(input) || !id(input.requestId) || !id(input.attemptId)) throw new StorageError('INVALID_COMMAND');
    // Copy before awaiting actor resolution so callers cannot change in-flight commands.
    let command: ApplyCommand;
    try { command = structuredClone(input); } catch { throw new StorageError('INVALID_COMMAND'); }
    let actor: Actor | null;
    try { actor = structuredClone(await this.#options.resolveActor(principal, command.requestId)); }
    catch { actor = null; }
    // Critical section: fresh read after the await; no further await until commit.
    const base = this.#data;
    const state = base.workflows.get(command.requestId) ?? null;
    let fingerprint: string;
    let validJson = true;
    try { fingerprint = canonicalizeJson({ command, actor }); }
    catch { validJson = false; fingerprint = 'invalid-json'; }
    const attempt = base.attempts.get(key(command.requestId, command.attemptId));
    if (attempt) {
      if (!validJson || attempt.fingerprint !== fingerprint) throw new StorageError('ATTEMPT_ID_REUSED');
      return { ...structuredClone(attempt.result), replayed: true };
    }
    const deny = (reason: string) => {
      const update = this.#append(base, command, fingerprint, this.#rejection(state, command, actor, reason), !actor);
      this.#commit(update.data); return structuredClone(update.result);
    };
    if (!actor) return deny('UNAUTHORIZED');
    if (!validJson || !obj(command.event) || Object.hasOwn(command.event, 'actor') ||
        Object.keys(command).some(k => !['attemptId', 'requestId', 'event', 'snapshots', 'expectedActorId', 'preconditionFailure', 'commandFingerprint', 'jobIntent', 'draftingResult', 'callbackValidation', 'checkerResult', 'checkerAttempt', 'compilationIntent', 'compilationResult', 'compilationAttempt'].includes(k))) return deny('INVALID_COMMAND');
    if ((command.expectedActorId !== undefined && !id(command.expectedActorId)) ||
        (command.preconditionFailure !== undefined && !id(command.preconditionFailure)) ||
        (command.commandFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(command.commandFingerprint))) return deny('INVALID_COMMAND');
    if (command.expectedActorId !== undefined && actor.id !== command.expectedActorId) return deny('IDENTITY_CHANGED');
    if (!obj(command.event.request) || command.event.request.requestId !== command.requestId) return deny('REQUEST_SCOPE_MISMATCH');
    if (state) this.#assertSnapshots(state, base.snapshots); // Corrupt stored state/evidence blocks writes.
    const checkerFingerprint = base.checkerEventFingerprints.get(key(command.requestId, command.event.eventId));
    if (checkerFingerprint !== undefined && checkerFingerprint !== command.commandFingerprint) return deny('EVENT_ID_REUSED');
    const priorReceipt = base.receipts.get(key(command.requestId, command.event.eventId));
    if (priorReceipt && priorReceipt.commandFingerprint !== command.commandFingerprint) return deny('EVENT_ID_REUSED');
    if (command.preconditionFailure !== undefined) return deny(command.preconditionFailure);
    if (command.compilationResult !== undefined && !['COMPILED', 'FAIL'].includes(command.event.type)) return deny('UNRELATED_COMPILATION_RESULT');
    if ((command.event.type === 'COMPILED' || command.event.type === 'FAIL' && state?.status === 'COMPILING') &&
        (state?.compilationId && base.compilationJobs.has(key(command.requestId, state.compilationId))) && !command.compilationResult) return deny('COMPILATION_RESULT_REQUIRED');
    if (command.compilationIntent !== undefined && command.event.type !== 'START_COMPILATION') return deny('UNRELATED_COMPILATION_INTENT');
    // Existing legacy fixture-only paths stay compatible; formal/app paths require an atomic intent/outbox.
    if (command.event.type === 'START_COMPILATION' && (command.commandFingerprint !== undefined || state?.checks?.invocationId !== undefined) && !command.compilationIntent) return deny('COMPILATION_INTENT_REQUIRED');
    if (command.jobIntent !== undefined && command.event.type !== 'START_LOGIC_PROPOSAL') return deny('UNRELATED_JOB_INTENT');
    if (command.callbackValidation !== undefined && (command.event.type !== 'LOGIC_PROPOSED' || !validationReference(command.callbackValidation))) return deny('INVALID_VALIDATION_REFERENCE');
    if (command.draftingResult !== undefined && command.event.type !== 'LOGIC_PROPOSED') return deny('UNRELATED_DRAFTING_RESULT');
    if (command.event.type === 'LOGIC_PROPOSED' && command.commandFingerprint !== undefined && command.draftingResult === undefined) return deny('DRAFTING_RESULT_REQUIRED');
    if (command.checkerResult !== undefined && command.event.type !== 'LOGIC_CHECKED') return deny('UNRELATED_CHECKER_RESULT');
    if (command.event.type === 'LOGIC_CHECKED' && (command.event.invocationId !== undefined || command.commandFingerprint !== undefined ||
        [...base.draftingResults.values()].some(r => r.requestId === command.requestId && checkerSame(r.requestPreview, command.event.request)) ||
        [...base.checkerInvocations.values()].some(i => i.requestId === command.requestId && checkerSame(i.requestPreview, command.event.request))) && command.checkerResult === undefined) return deny('CHECKER_RESULT_REQUIRED');
    const event = { ...command.event, actor } as WorkflowEvent;
    const transition = transitionWorkflow(state, event);
    if (transition.outcome !== 'ACCEPTED') {
      const update = this.#append(base, command, fingerprint, transition.audit);
      this.#commit(update.data); return structuredClone(update.result);
    }
    // Build all replacement records off to the side. A rejected stage saves only audit.
    try {
      const next = transition.state!;
      let jobIntent: DraftingJobIntent | undefined;
      const jobs = new Map(base.jobs);
      if (event.type === 'START_LOGIC_PROPOSAL') {
        // Even direct internal store commands cannot advance drafting without an intent.
        const routes = [...base.receipts.values()].filter(r => r.routing?.route === 'READY_FOR_BEDROCK_REVIEW' &&
          r.workflowVersion === state!.version && canonicalizeJson(r.request) === canonicalizeJson(identity(state!)) &&
          canonicalizeJson(r.routing) === canonicalizeJson(state!.routing) && state!.processedEvents.some(e => e.eventId === r.eventId && e.fingerprint === r.fingerprint));
        if (routes.length !== 1) return deny('CURRENT_ROUTING_RECEIPT_REQUIRED');
        jobIntent = createDraftingIntent(identity(state!), state!.version, routes[0].eventId, event.eventId);
        if (command.jobIntent !== undefined && canonicalizeJson(command.jobIntent) !== canonicalizeJson(jobIntent)) return deny('INVALID_JOB_INTENT');
        if ([...jobs.values()].some(j => j.requestId === command.requestId && j.sourceWorkflowVersion === state!.version)) return deny('JOB_ALREADY_EXISTS');
        const slot = key(command.requestId, jobIntent.jobId);
        if (jobs.has(slot)) return deny('JOB_ID_REUSED');
        jobs.set(slot, structuredClone(jobIntent));
      }
      const compilationJobs = new Map(base.compilationJobs), compilationOutboxes = new Map(base.compilationOutboxes);
      let compilationIntent: CompilationJobIntent | undefined, outbox: CompilationOutbox | undefined;
      if (command.compilationIntent !== undefined) {
        const job = command.compilationIntent;
        if (!state || event.type !== 'START_COMPILATION') return deny('INVALID_COMPILATION_INTENT');
        const preview = this.#readSnapshot(base.snapshots, { kind: 'REQUEST_PREVIEW', requestId: command.requestId, revision: state.brief.revision });
        const model = state.logic ? this.#readSnapshot(base.snapshots, { kind: 'LOGIC_MODEL', requestId: command.requestId, revision: state.logic.logicRevision, requestPreview: identity(state) }) : null;
        const records = [...base.evidence.values()].filter(r => r.requestId === command.requestId);
        const clinicalReceipt = state.clinicalApproval ? base.receipts.get(key(command.requestId, state.clinicalApproval.eventId)) ?? null : null;
        const check = records.find(r => r.kind === 'LOGIC_CHECKED' && r.recordId === state.checks?.reportId);
        const checkerReceipt = check ? base.receipts.get(key(command.requestId, check.event.eventId)) ?? null : null;
        const failure = compilationEvidenceFailure(state, preview, model, records, clinicalReceipt, checkerReceipt);
        if (failure) return deny(failure);
        if (!model || model.kind !== 'LOGIC_MODEL' || !validCompilationIntent(job, model) || job.sourceWorkflowVersion !== state.version || job.workflowVersion !== next.version ||
            job.clinicalApprovalId !== state.clinicalApproval?.eventId || job.checkerReportId !== state.checks?.reportId || job.checkerInvocationId !== state.checks?.invocationId ||
            job.handoffEventId !== event.eventId || job.jobId !== event.compilationId || job.createdBy !== actor.id) return deny('INVALID_COMPILATION_INTENT');
        if ([...compilationJobs.values()].some(old => old.requestId === command.requestId && old.clinicalApprovalId === job.clinicalApprovalId &&
            checkerSame(old.requestPreview, job.requestPreview) && old.logicModelHash === job.logicModelHash && old.logicModelRevision === job.logicModelRevision)) return deny('COMPILATION_JOB_ALREADY_EXISTS');
        const slot = key(command.requestId, job.jobId);
        if (compilationJobs.has(slot) || compilationOutboxes.has(slot)) return deny('COMPILATION_JOB_ID_REUSED');
        compilationIntent = structuredClone(job); outbox = compilationOutbox(job);
        compilationJobs.set(slot, compilationIntent); compilationOutboxes.set(slot, outbox);
      }
      const snapshots = new Map(base.snapshots);
      const incoming: string[] = [];
      if (command.snapshots !== undefined && !Array.isArray(command.snapshots)) return deny('INVALID_SNAPSHOTS');
      for (const supplied of command.snapshots ?? []) {
        const snapshot = verifySnapshot(supplied, this.#options.validateSnapshot);
        if (snapshot.requestId !== command.requestId) return deny('SNAPSHOT_SCOPE_MISMATCH');
        const slot = snapshotSlot(snapshotKey(snapshot)), bytes = canonicalizeJson(snapshot);
        const existing = snapshots.get(slot);
        if (existing !== undefined && existing !== bytes) return deny('SNAPSHOT_CONFLICT');
        snapshots.set(slot, bytes); incoming.push(slot);
      }
      const required = this.#assertSnapshots(next, snapshots);
      if (incoming.some(slot => !required.has(slot))) return deny('UNRELATED_SNAPSHOT');
      const draftingResults = new Map(base.draftingResults);
      let draftingResult: DraftingResultRecord | undefined;
      if (command.draftingResult !== undefined) {
        const r = command.draftingResult;
        if (!obj(r) || event.type !== 'LOGIC_PROPOSED' || !id(r.jobId)) return deny('INVALID_DRAFTING_RESULT');
        const job = base.jobs.get(key(command.requestId, r.jobId));
        if (!job || job.jobType !== 'DRAFT_LOGIC') return deny('JOB_NOT_FOUND');
        const handoff = base.receipts.get(key(command.requestId, job.handoffEventId));
        if (!handoff || handoff.jobId !== job.jobId || handoff.workflowVersion !== job.workflowVersion ||
            canonicalizeJson(handoff.request) !== canonicalizeJson(job.requestPreview)) return deny('JOB_INTEGRITY');
        if (state!.version !== job.workflowVersion || canonicalizeJson(identity(state!)) !== canonicalizeJson(job.requestPreview)) return deny('STALE_JOB');
        const model = this.#readSnapshot(snapshots, { kind: 'LOGIC_MODEL', requestId: command.requestId, revision: event.logicRevision, requestPreview: identity(state!) });
        if (!model || model.snapshotHash !== event.logicHash || !validationMatches(r.validation, model)) return deny('INVALID_VALIDATION_EVIDENCE');
        const expected: DraftingResultRecord = { requestId: command.requestId, jobId: job.jobId, eventId: event.eventId,
          requestPreview: identity(state!), sourceWorkflowVersion: job.sourceWorkflowVersion, jobWorkflowVersion: job.workflowVersion,
          acceptedWorkflowVersion: next.version, handoffEventId: job.handoffEventId,
          logic: { logicRevision: event.logicRevision, logicHash: event.logicHash }, validation: r.validation };
        if (canonicalizeJson(r) !== canonicalizeJson(expected)) return deny('INVALID_DRAFTING_RESULT');
        const slot = key(command.requestId, job.jobId);
        if (draftingResults.has(slot)) return deny('JOB_RESULT_ALREADY_ACCEPTED');
        draftingResult = structuredClone(expected); draftingResults.set(slot, draftingResult);
      }
      const checkerReports = new Map(base.checkerReports);
      let checkerResult: AcceptedCheckerResult | undefined;
      if (command.checkerResult !== undefined) {
        const r = command.checkerResult;
        if (!validCheckerResult(r) || event.type !== 'LOGIC_CHECKED') return deny('INVALID_CHECKER_RESULT');
        const invocation = base.checkerInvocations.get(key(command.requestId, r.invocation.invocationId));
        if (!invocation || !checkerSame(invocation, r.invocation)) return deny('CHECKER_INVOCATION_REQUIRED');
        const authorization = base.receipts.get(key(command.requestId, invocation.eventId));
        if (!authorization?.checkerInvocation || !checkerSame(authorization.checkerInvocation, invocation)) return deny('CHECKER_INVOCATION_INTEGRITY');
        if (actor.id !== invocation.checkerActorId) return deny('WORKER_NOT_AUTHORIZED');
        if (state!.version !== invocation.workflowVersion || !checkerSame(identity(state!), invocation.requestPreview) || !checkerSame(state!.logic, invocation.logic)) return deny('STALE_CHECKER_INVOCATION');
        if (r.eventId !== event.eventId || r.workflowVersion !== next.version || r.report.requestId !== command.requestId ||
            r.report.reportId !== event.reportId || r.passed !== event.passed || event.invocationId !== invocation.invocationId ||
            !checkerSame({ logicRevision: event.logicRevision, logicHash: event.logicHash }, invocation.logic)) return deny('CHECKER_EVIDENCE_MISMATCH');
        if ([...checkerReports.values()].some(old => old.report.requestId === command.requestId && checkerSame(old.report.requestPreview, invocation.requestPreview) && checkerSame(old.report.logic, invocation.logic))) return deny('CHECKER_RESULT_ALREADY_ACCEPTED');
        const reportSlot = key(command.requestId, r.report.reportId);
        if (checkerReports.has(reportSlot)) return deny('CHECKER_REPORT_ID_REUSED');
        checkerResult = structuredClone(r); checkerReports.set(reportSlot, checkerResult);
      }
      const compilationResults = new Map(base.compilationResults);
      let compilationResult: CompilationResultRecord | undefined;
      if (command.compilationResult !== undefined) {
        const r = command.compilationResult, job = base.compilationJobs.get(key(command.requestId, r.jobId));
        if (!state || !job || !['COMPILED', 'FAIL'].includes(event.type)) return deny('COMPILATION_JOB_REQUIRED');
        const model = this.#readSnapshot(base.snapshots, { kind: 'LOGIC_MODEL', requestId: command.requestId, revision: job.logicModelRevision, requestPreview: job.requestPreview });
        const preview = this.#readSnapshot(base.snapshots, { kind: 'REQUEST_PREVIEW', requestId: command.requestId, revision: state.brief.revision });
        const records = [...base.evidence.values()].filter(e => e.requestId === command.requestId);
        const check = records.find(e => e.kind === 'LOGIC_CHECKED' && e.recordId === state.checks?.reportId);
        const clinicalReceipt = base.receipts.get(key(command.requestId, job.clinicalApprovalId)) ?? null;
        const checkerReceipt = check ? base.receipts.get(key(command.requestId, check.event.eventId)) ?? null : null;
        const failure = compilationEvidenceFailure(state, preview, model, records, clinicalReceipt, checkerReceipt);
        if (failure) return deny(failure);
        if (!model || model.kind !== 'LOGIC_MODEL' || !resultMatchesJob(r, job, model) || r.eventId !== event.eventId || r.acceptedWorkflowVersion !== next.version ||
            job.workflowVersion !== state.version || state.compilationId !== job.jobId || !checkerSame(identity(state), job.requestPreview) ||
            state.clinicalApproval?.eventId !== job.clinicalApprovalId || r.execution.runnerActorId !== actor.id || actor.id === state.clinicalApproval.actorId) return deny('INVALID_COMPILATION_RESULT');
        if (!this.#options.compilationExecutionIsCurrent) return deny('EXECUTION_CONDITION_REQUIRED');
        if (this.#options.compilationExecutionIsCurrent(structuredClone(r.execution)) !== true) return deny('STALE_JOB_ATTEMPT');
        if (event.type === 'COMPILED' ? r.outcome !== 'COMPILED' || event.artifact.artifactHash !== r.artifact?.packagedObject.sha256 : r.outcome !== 'FAILED') return deny('COMPILATION_RESULT_MISMATCH');
        const slot = key(command.requestId, job.jobId);
        if (compilationResults.has(slot)) return deny('COMPILATION_RESULT_ALREADY_ACCEPTED');
        compilationResult = structuredClone(r); compilationResults.set(slot, compilationResult);
      }
      const evidence = new Map(base.evidence);
      const record = evidenceFromEvent(event);
      if (record) {
        const recordKey = key(command.requestId, record.kind, record.recordId);
        if (evidence.has(recordKey)) return deny('EVIDENCE_ID_REUSED');
        evidence.set(recordKey, { ...record, ...(checkerResult ? { checkerResult: structuredClone(checkerResult) } : {}), ...(compilationResult ? { compilationResult } : {}) });
      }
      const update = this.#append(base, command, fingerprint, transition.audit, false, { ...(jobIntent ? { jobIntent } : {}), ...(draftingResult ? { draftingResult } : {}), ...(checkerResult ? { checkerResult } : {}), ...(compilationIntent ? { compilationIntent, compilationOutbox: outbox } : {}), ...(compilationResult ? { compilationResult } : {}) });
      const receiptKey = key(command.requestId, event.eventId);
      if (base.receipts.has(receiptKey)) throw new StorageError('RECEIPT_CONFLICT');
      const processed = next.processedEvents.find(item => item.eventId === event.eventId);
      if (!processed) throw new StorageError('MISSING_EVENT_RECEIPT');
      const receipt: EventReceipt = { request: identity(next), eventId: event.eventId,
        fingerprint: processed.fingerprint, workflowVersion: next.version, auditId: update.result.auditId,
        ...(command.commandFingerprint === undefined ? {} : { commandFingerprint: command.commandFingerprint }),
        ...(jobIntent ? { jobId: jobIntent.jobId } : {}),
        ...(compilationIntent ? { compilationJobId: compilationIntent.jobId } : {}),
        ...(compilationResult ? { compilationResult } : {}),
        ...(draftingResult ? { draftingResult: structuredClone(draftingResult) } : {}),
        ...(checkerResult ? { checkerResult: structuredClone(checkerResult) } : {}),
        ...(event.type === 'APPLY_ROUTING' ? { routing: structuredClone(event.result) } : {}) };
      const candidate: MemoryData = { ...update.data, jobs, compilationJobs, compilationResults, compilationOutboxes, draftingResults, checkerReports, snapshots, evidence, workflows: new Map(base.workflows), receipts: new Map(base.receipts) };
      candidate.workflows.set(command.requestId, structuredClone(next));
      candidate.receipts.set(receiptKey, receipt);
      this.#commit(candidate);
      return structuredClone(update.result);
    } catch (error) {
      if (error instanceof StorageError && error.code !== 'TRANSACTION_FAILED' && error.code !== 'INVALID_CLOCK') return deny(error.code);
      throw error;
    }
  }
}

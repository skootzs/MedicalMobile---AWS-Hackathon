import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson, createSnapshot, SnapshotError } from './snapshots.ts';
import type { LogicModelSnapshot } from './snapshots.ts';
import { validationMatches, validationReference } from './callback-contracts.ts';
import type { DraftingResultRecord, LogicValidationBoundary, LogicValidationReference } from './callback-contracts.ts';
import type { DraftingJobIntent } from './job-intents.ts';
import type { RevisionIdentity } from './routing.ts';
import type { Actor } from './workflow.ts';
import type { ApplyResult, StoreDependencies } from './storage/requests.ts';
import type { DraftingResultStore } from './storage/drafting-results.ts';
import type { EventReceipt } from './storage/audit.ts';

/** Internal R3 data only; no callback role, trusted flag, computed hash or approval. */
export interface DraftingResultCommand extends RevisionIdentity {
  jobId: string;
  eventId: string;
  expectedVersion: number;
  sourceWorkflowVersion: number;
  schemaVersion: string;
  logicModel: unknown;
}
export interface DraftingCallbackResult {
  status: 'ACCEPTED' | 'DUPLICATE_EVENT' | 'BLOCKED' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  result: DraftingResultRecord | null;
  /** Original accepted version/audit on accepted retries, not a current-state claim. */
  workflowVersion: number | null;
  auditId: string | null;
  attemptAuditId: string | null;
  validationReference: LogicValidationReference | null;
}
export interface DraftingCallbackDependencies {
  store: DraftingResultStore;
  resolveActor: StoreDependencies['resolveActor'];
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Additional trusted job authorization; cannot elevate a non-DRAFTER. */
  authorizeWorker?(actor: Readonly<Actor>, job: DraftingJobIntent): boolean | Promise<boolean>;
  /** No pretend R4 success when this boundary is absent or unavailable. */
  validation?: LogicValidationBoundary;
  newAttemptId?: () => string;
}
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && v.length <= 100;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const identity = (v: RevisionIdentity): RevisionIdentity => ({ requestId: v.requestId, revision: v.revision, snapshotHash: v.snapshotHash });
function parse(raw: DraftingResultCommand): DraftingResultCommand | null {
  try {
    const c: unknown = JSON.parse(canonicalizeJson(raw));
    const keys = ['requestId', 'jobId', 'eventId', 'expectedVersion', 'sourceWorkflowVersion', 'revision', 'snapshotHash', 'schemaVersion', 'logicModel'];
    if (!object(c) || Object.keys(c).length !== keys.length || !Object.keys(c).every(k => keys.includes(k)) ||
        !id(c.requestId) || !id(c.jobId) || !id(c.eventId) || !id(c.schemaVersion) || !positive(c.expectedVersion) ||
        !positive(c.sourceWorkflowVersion) || !positive(c.revision) || typeof c.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.snapshotHash) || !object(c.logicModel)) return null;
    return c as unknown as DraftingResultCommand;
  } catch { return null; }
}
/** Coordinates existing LOGIC_PROPOSED; no listener, R3 drafting or R4 checker implementation. */
export class DraftingCallbackService {
  #deps: DraftingCallbackDependencies;
  constructor(deps: DraftingCallbackDependencies) {
    if (!deps.store || typeof deps.store.getDraftingResult !== 'function' || typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function') throw Error('Trusted worker identity, visibility and callback storage are required.');
    this.#deps = deps;
  }
  async #accepted(receipt: EventReceipt, c: DraftingResultCommand): Promise<{ record: DraftingResultRecord; snapshot: LogicModelSnapshot }> {
    const record = await this.#deps.store.getDraftingResult(c.requestId, c.jobId);
    const model = record ? await this.#deps.store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: c.requestId, revision: record.logic.logicRevision, requestPreview: record.requestPreview }) : null;
    if (!record || !model || model.kind !== 'LOGIC_MODEL' || record.eventId !== c.eventId || receipt.eventId !== c.eventId ||
        record.jobWorkflowVersion !== c.expectedVersion || record.sourceWorkflowVersion !== c.sourceWorkflowVersion ||
        !same(record.requestPreview, identity(c)) || !same(receipt.draftingResult, record) || receipt.workflowVersion !== record.acceptedWorkflowVersion ||
        model.schemaVersion !== c.schemaVersion || model.snapshotHash !== record.logic.logicHash || !same(model.content, c.logicModel) || !validationMatches(record.validation, model)) throw Error('Accepted callback integrity failure.');
    return { record, snapshot: model };
  }
  async ingest(input: DraftingResultCommand, principal: unknown): Promise<DraftingCallbackResult> {
    const c = parse(input);
    let validationRef: LogicValidationReference | null = null;
    const reply = (status: DraftingCallbackResult['status'], reason: string, stored?: ApplyResult, record: DraftingResultRecord | null = null, receipt?: EventReceipt): DraftingCallbackResult => ({
      status, reason, result: record, workflowVersion: record?.acceptedWorkflowVersion ?? stored?.version ?? null,
      auditId: receipt?.auditId ?? stored?.auditId ?? null, attemptAuditId: stored?.auditId ?? null, validationReference: record ? validationReference(record.validation) : validationRef,
    });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      const actor: Actor | null = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !id(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      let failure: string | undefined;
      if (!actor.roles.includes('DRAFTER')) failure = 'WRONG_ROLE';
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor?.id ?? null }), 'utf8').digest('hex');
      let snapshot: LogicModelSnapshot | undefined;
      let record: DraftingResultRecord | undefined;
      let job: DraftingJobIntent | null = null;
      if (!failure) {
        job = await this.#deps.store.getJob(c.requestId, c.jobId);
        const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (!job) failure = 'JOB_NOT_FOUND';
        else if (job.jobType !== 'DRAFT_LOGIC') failure = 'WRONG_JOB_TYPE';
        else if (this.#deps.authorizeWorker && await this.#deps.authorizeWorker(actor!, job) !== true) failure = 'WORKER_NOT_AUTHORIZED';
        else if (receipt?.commandFingerprint === fingerprint) ({ snapshot, record } = await this.#accepted(receipt, c));
        else {
          const state = await this.#deps.store.getWorkflow(c.requestId);
          if (receipt) failure = 'EVENT_ID_REUSED';
          else if (!state) failure = 'REQUEST_NOT_FOUND';
          else if (state.brief.requestId !== c.requestId || job.requestId !== c.requestId) failure = 'JOB_NOT_FOUND';
          else if (state.version !== c.expectedVersion || job.workflowVersion !== c.expectedVersion) failure = 'VERSION_CONFLICT';
          else if (!same(identity(state.brief), identity(c)) || !same(job.requestPreview, identity(c))) failure = 'STALE_REQUEST';
          else if (job.sourceWorkflowVersion !== c.sourceWorkflowVersion) failure = 'STALE_JOB';
          else if (state.status !== 'DRAFTING_LOGIC') failure = 'WRONG_STATE';
          else if (await this.#deps.store.getDraftingResult(c.requestId, c.jobId)) failure = 'JOB_RESULT_ALREADY_ACCEPTED';
          else {
            const handoff = await this.#deps.store.getReceipt(c.requestId, job.handoffEventId);
            if (!handoff || handoff.jobId !== job.jobId || handoff.workflowVersion !== job.workflowVersion || !same(handoff.request, job.requestPreview)) failure = 'JOB_INTEGRITY';
            else if (!this.#deps.validation || typeof this.#deps.validation.validateSnapshot !== 'function' || typeof this.#deps.validation.validateProposal !== 'function') failure = 'VALIDATION_UNAVAILABLE';
            else {
              try {
                const model = createSnapshot({ kind: 'LOGIC_MODEL', requestId: c.requestId, revision: 1, schemaVersion: c.schemaVersion,
                  requestPreview: identity(c), content: c.logicModel }, this.#deps.validation.validateSnapshot);
                if (model.kind !== 'LOGIC_MODEL') throw Error('Invalid model kind.');
                snapshot = model;
              } catch (error) { if (error instanceof SnapshotError) failure = 'INVALID_LOGIC_MODEL'; else throw error; }
              if (!failure) {
                let evidence: unknown;
                try { evidence = JSON.parse(canonicalizeJson(await this.#deps.validation.validateProposal(snapshot!))); }
                catch { failure = 'VALIDATION_UNAVAILABLE'; }
                if (!failure) {
                  validationRef = validationReference(evidence);
                  if (object(evidence) && evidence.status === 'FAILED') failure = 'VALIDATION_FAILED';
                  else if (evidence === null || object(evidence) && evidence.status === 'UNAVAILABLE') failure = 'VALIDATION_UNAVAILABLE';
                  else if (!validationMatches(evidence, snapshot!)) failure = 'INVALID_VALIDATION_EVIDENCE';
                  else record = { requestId: c.requestId, jobId: job.jobId, eventId: c.eventId, requestPreview: identity(c),
                    sourceWorkflowVersion: job.sourceWorkflowVersion, jobWorkflowVersion: job.workflowVersion, acceptedWorkflowVersion: job.workflowVersion + 1,
                    handoffEventId: job.handoffEventId, logic: { logicRevision: snapshot!.revision, logicHash: snapshot!.snapshotHash }, validation: evidence };
                }
              }
            }
          }
        }
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
        const latestActor = await this.#deps.resolveActor(principal, c.requestId);
        if (!latestActor || !latestActor.roles.includes('DRAFTER') || latestActor.id !== actor!.id) failure = 'IDENTITY_CHANGED';
        if (job && this.#deps.authorizeWorker && await this.#deps.authorizeWorker(actor!, job) !== true) failure = 'WORKER_NOT_AUTHORIZED';
        const latest = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (latest?.commandFingerprint === fingerprint && !['IDENTITY_CHANGED', 'WORKER_NOT_AUTHORIZED', 'WRONG_JOB_TYPE', 'JOB_NOT_FOUND'].includes(failure ?? '')) {
          ({ snapshot, record } = await this.#accepted(latest, c)); failure = undefined;
        } else if (latest && latest.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      }
      // Empty hash is an invalid rejection-only placeholder, never an invented snapshot.
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(),
        event: { type: 'LOGIC_PROPOSED', eventId: c.eventId, expectedVersion: c.expectedVersion, request: identity(c), logicRevision: 1, logicHash: snapshot?.snapshotHash ?? '' },
        commandFingerprint: fingerprint, ...(actor ? { expectedActorId: actor.id } : {}), ...(failure ? { preconditionFailure: failure } : {}),
        ...(validationRef ? { callbackValidation: validationRef } : {}),
        ...(record ? { draftingResult: record } : {}), ...(!failure && snapshot ? { snapshots: [snapshot] } : {}) }, principal);
      if (stored.outcome === 'REJECTED') {
        const status = ['VERSION_CONFLICT', 'STALE_REQUEST', 'STALE_JOB'].includes(stored.reason) ? 'STALE_VERSION'
          : ['VALIDATION_UNAVAILABLE', 'INVALID_VALIDATION_EVIDENCE'].includes(stored.reason) ? 'BLOCKED' : 'REJECTED';
        return reply(status, stored.reason, stored);
      }
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      if (!receipt) return reply('STORAGE_FAILURE', 'CALLBACK_RECEIPT_INTEGRITY');
      const accepted = await this.#accepted(receipt, c);
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'ACCEPTED', stored.reason, stored, accepted.record, receipt);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

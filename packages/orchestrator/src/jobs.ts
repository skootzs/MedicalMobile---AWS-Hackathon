import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import { createDraftingIntent } from './job-intents.ts';
import type { DraftingJobIntent, DraftingWorker, WorkerOutcome } from './job-intents.ts';
import type { RevisionIdentity } from './routing.ts';
import type { Actor } from './workflow.ts';
import type { RoutingServiceDependencies } from './routing-service.ts';
import type { ApplyResult } from './storage/requests.ts';
import type { JobStore } from './storage/jobs.ts';
import type { EventReceipt } from './storage/audit.ts';

/** Provisional internal commands; no HTTP endpoint or browser identity fields. */
export interface DraftingHandoffCommand extends RevisionIdentity { eventId: string; expectedVersion: number; routingEventId: string }
export interface DeliverDraftingCommand { requestId: string; jobId: string; expectedVersion: number }
export interface HandoffResult {
  status: 'INTENT_RECORDED' | 'DUPLICATE_EVENT' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  job: DraftingJobIntent | null;
  workflowVersion: number | null;
  auditId: string | null;
}
export interface DeliveryResult {
  status: 'DELIVERED' | 'DUPLICATE_DELIVERY' | 'TEMPORARY_UNAVAILABLE' | 'DISPATCH_FAILED' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  jobId: string | null;
  workerOutcome: WorkerOutcome | 'NOT_ATTEMPTED';
  auditId: string | null;
}
export interface DraftingHandoffDependencies extends Pick<RoutingServiceDependencies, 'resolveActor' | 'canAccessRequest' | 'authorizeActor' | 'newAttemptId'> {
  store: JobStore;
  /** Only explicit deliver() uses this adapter. start() never calls it. */
  worker?: DraftingWorker;
}
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && v.length <= 100;
const version = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const identity = (v: RevisionIdentity): RevisionIdentity => ({ requestId: v.requestId, revision: v.revision, snapshotHash: v.snapshotHash });
function parse<T>(raw: T, keys: readonly string[]): T | null {
  try {
    const v = JSON.parse(canonicalizeJson(raw)) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || !Object.keys(v).every(k => keys.includes(k)) ||
        !id(v.requestId) || !version(v.expectedVersion)) return null;
    return v as T;
  } catch { return null; }
}
/** Explicit local coordinator. Worker acceptance is never completion or approval. */
export class DraftingHandoffService {
  #deps: DraftingHandoffDependencies;
  constructor(deps: DraftingHandoffDependencies) {
    if (!deps.store || typeof deps.store.getJob !== 'function' || typeof deps.store.recordJobDelivery !== 'function' ||
        typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function') throw Error('Trusted identity, access and job storage are required.');
    this.#deps = deps;
  }
  async #actor(principal: unknown, requestId: string): Promise<{ actor: Actor | null; failure?: string }> {
    const actor = structuredClone(await this.#deps.resolveActor(principal, requestId));
    if (!actor || !id(actor.id) || !Array.isArray(actor.roles)) return { actor: null, failure: 'UNAUTHORIZED' };
    if (!actor.roles.includes('ORCHESTRATOR') || this.#deps.authorizeActor && await this.#deps.authorizeActor(actor, requestId) !== true) return { actor, failure: 'WRONG_ROLE' };
    return { actor };
  }
  async #retryJob(receipt: EventReceipt, c: DraftingHandoffCommand): Promise<DraftingJobIntent> {
    const job = receipt.jobId ? await this.#deps.store.getJob(c.requestId, receipt.jobId) : null;
    if (!job || receipt.eventId !== c.eventId || receipt.workflowVersion !== job.workflowVersion || !same(receipt.request, identity(c)) ||
        !same(job, createDraftingIntent(identity(c), c.expectedVersion, c.routingEventId, c.eventId))) throw Error('Handoff receipt integrity failure.');
    return job;
  }
  async start(input: DraftingHandoffCommand, principal: unknown): Promise<HandoffResult> {
    const c = parse(input, ['requestId', 'eventId', 'expectedVersion', 'revision', 'snapshotHash', 'routingEventId']);
    const result = (status: HandoffResult['status'], reason: string, stored?: ApplyResult, job: DraftingJobIntent | null = null): HandoffResult => ({ status, reason,
      job, workflowVersion: stored?.version ?? null, auditId: stored?.auditId ?? null });
    if (!c || !id(c.eventId) || !id(c.routingEventId) || !version(c.revision) || typeof c.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.snapshotHash)) return result('REJECTED', 'INVALID_COMMAND');
    try {
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return result('REJECTED', 'REQUEST_NOT_FOUND');
      const auth = await this.#actor(principal, c.requestId);
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: auth.actor?.id ?? null })).digest('hex');
      let failure = auth.failure;
      let job = createDraftingIntent(identity(c), c.expectedVersion, c.routingEventId, c.eventId);
      if (!failure) {
        const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (receipt?.commandFingerprint === fingerprint) job = await this.#retryJob(receipt, c);
        else {
          const state = await this.#deps.store.getWorkflow(c.requestId);
          if (receipt) failure = 'EVENT_ID_REUSED';
          else if (!state) failure = 'REQUEST_NOT_FOUND';
          else if (state.version !== c.expectedVersion) failure = 'VERSION_CONFLICT';
          else if (!same(identity(state.brief), identity(c))) failure = 'STALE_REQUEST';
          else if (state.status !== 'READY_FOR_LOGIC_PROPOSAL') failure = 'WRONG_STATE';
          else {
            const route = await this.#deps.store.getReceipt(c.requestId, c.routingEventId);
            const preview = await this.#deps.store.getSnapshot({ kind: 'REQUEST_PREVIEW', requestId: c.requestId, revision: c.revision });
            const { requestId: _id, revision: _rev, snapshotHash: _hash, ...content } = state.brief;
            if (!route || route.eventId !== c.routingEventId || route.routing?.route !== 'READY_FOR_BEDROCK_REVIEW' || route.workflowVersion !== c.expectedVersion ||
                !same(route.request, identity(c)) || !same(route.routing, state.routing) || !state.processedEvents.some(e => e.eventId === c.routingEventId && e.fingerprint === route.fingerprint)) failure = 'CURRENT_ROUTING_RECEIPT_REQUIRED';
            else if (!preview || preview.kind !== 'REQUEST_PREVIEW' || !same(identity(preview), identity(c)) || !same(preview.content, content)) failure = 'SNAPSHOT_REQUIRED';
          }
        }
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return result('REJECTED', 'REQUEST_NOT_FOUND');
        if (this.#deps.authorizeActor && await this.#deps.authorizeActor(auth.actor!, c.requestId) !== true) failure = 'WRONG_ROLE';
        // Close the separate receipt/state-read race for an identical concurrent start.
        const latest = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (latest?.commandFingerprint === fingerprint && !['WRONG_ROLE', 'UNAUTHORIZED'].includes(failure ?? '')) { job = await this.#retryJob(latest, c); failure = undefined; }
        else if (latest && latest.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      }
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(),
        event: { type: 'START_LOGIC_PROPOSAL', eventId: c.eventId, expectedVersion: c.expectedVersion, request: identity(c) }, jobIntent: job,
        commandFingerprint: fingerprint, ...(auth.actor ? { expectedActorId: auth.actor.id } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return result(['VERSION_CONFLICT', 'STALE_REQUEST'].includes(stored.reason) ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
      const saved = await this.#deps.store.getJob(c.requestId, job.jobId);
      if (!saved || !same(saved, job)) return result('STORAGE_FAILURE', 'JOB_INTEGRITY');
      return result(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'INTENT_RECORDED', stored.reason, stored, saved);
    } catch { return result('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
  async deliver(input: DeliverDraftingCommand, principal: unknown): Promise<DeliveryResult> {
    const c = parse(input, ['requestId', 'jobId', 'expectedVersion']);
    let outcome: DeliveryResult['workerOutcome'] = 'NOT_ATTEMPTED';
    const result = (status: DeliveryResult['status'], reason: string, stored?: ApplyResult): DeliveryResult => ({ status, reason, jobId: c?.jobId ?? null,
      workerOutcome: outcome, auditId: stored?.auditId ?? null });
    if (!c || !id(c.jobId)) return result('REJECTED', 'INVALID_COMMAND');
    try {
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return result('REJECTED', 'REQUEST_NOT_FOUND');
      const auth = await this.#actor(principal, c.requestId); let failure = auth.failure;
      if (!failure) {
        const job = await this.#deps.store.getJob(c.requestId, c.jobId), state = await this.#deps.store.getWorkflow(c.requestId);
        if (!job || !state) failure = 'JOB_NOT_FOUND';
        else if (state.version !== c.expectedVersion || state.version !== job.workflowVersion) failure = 'VERSION_CONFLICT';
        else if (!same(identity(state.brief), job.requestPreview)) failure = 'STALE_REQUEST';
        else if (state.status !== 'DRAFTING_LOGIC') failure = 'WRONG_STATE';
        else if (!this.#deps.worker) failure = 'WORKER_NOT_CONFIGURED';
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return result('REJECTED', 'REQUEST_NOT_FOUND');
        const currentAuth = await this.#actor(principal, c.requestId);
        if (currentAuth.failure) failure = currentAuth.failure;
        else if (currentAuth.actor!.id !== auth.actor!.id) failure = 'IDENTITY_CHANGED';
        if (!failure) {
          try {
            const response = await this.#deps.worker!.deliver(structuredClone(job!));
            if (!response || !['ACCEPTED', 'UNAVAILABLE', 'FAILED', 'DUPLICATE'].includes(response.outcome) || response.jobId !== job!.jobId || response.idempotencyKey !== job!.idempotencyKey) {
              outcome = 'FAILED'; failure = 'WORKER_PROTOCOL_ERROR';
            } else outcome = response.outcome;
          } catch { outcome = 'FAILED'; }
        }
      }
      const stored = await this.#deps.store.recordJobDelivery({ ...c, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), outcome,
        ...(auth.actor ? { expectedActorId: auth.actor.id } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (['VERSION_CONFLICT', 'STALE_REQUEST'].includes(stored.reason)) return result('STALE_VERSION', stored.reason, stored);
      if (stored.outcome === 'REJECTED') return result(stored.reason === 'WORKER_UNAVAILABLE' ? 'TEMPORARY_UNAVAILABLE' :
        ['WORKER_FAILED', 'WORKER_PROTOCOL_ERROR'].includes(stored.reason) ? 'DISPATCH_FAILED' : 'REJECTED', stored.reason, stored);
      return result(outcome === 'DUPLICATE' ? 'DUPLICATE_DELIVERY' : 'DELIVERED', stored.reason, stored);
    } catch { return result('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

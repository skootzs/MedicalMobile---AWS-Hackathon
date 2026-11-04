import { canonicalizeJson } from '../snapshots.ts';
import type { Snapshot } from '../snapshots.ts';
import { transitionWorkflow } from '../workflow.ts';
import type { Actor, ProposedAuditEvent, WorkflowEvent, WorkflowState } from '../workflow.ts';
import { evidenceFromEvent } from './artifacts.ts';
import type { EvidenceRecord } from './artifacts.ts';
import type { AuditRecord, EventReceipt } from './audit.ts';
import { StorageError } from './requests.ts';
import type { ApplyCommand, ApplyResult, OrchestratorStore, ReviewCandidateSource, SnapshotKey, StoreDependencies } from './requests.ts';
import { snapshotKey, snapshotSlot, verifySnapshot } from './snapshots.ts';

interface Attempt { fingerprint: string; result: ApplyResult }
interface MemoryData {
  workflows: Map<string, WorkflowState>;
  snapshots: Map<string, string>;
  receipts: Map<string, EventReceipt>;
  evidence: Map<string, EvidenceRecord>;
  audits: Map<string, readonly AuditRecord[]>;
  attempts: Map<string, Attempt>;
}
export interface InMemoryOptions extends StoreDependencies {
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
export class InMemoryOrchestratorStore implements OrchestratorStore, ReviewCandidateSource {
  #data: MemoryData = { workflows: new Map(), snapshots: new Map(), receipts: new Map(), evidence: new Map(), audits: new Map(), attempts: new Map() };
  #options: InMemoryOptions;
  constructor(options: InMemoryOptions) {
    if (typeof options.resolveActor !== 'function' || typeof options.validateSnapshot !== 'function') throw new StorageError('MISSING_BACKEND_BOUNDARY');
    this.#options = options;
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
    for (const { event } of records) {
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
    }
    return structuredClone(records);
  }
  async listAudit(requestId: string): Promise<readonly AuditRecord[]> { return structuredClone(this.#data.audits.get(requestId) ?? []); }

  #commit(candidate: MemoryData) {
    try {
      const returned = this.#options.testFaults?.beforeCommit?.();
      if (returned !== undefined) throw new Error('Synchronous fault hook required.');
    } catch { throw new StorageError('TRANSACTION_FAILED'); }
    this.#data = candidate;
  }
  #append(base: MemoryData, command: ApplyCommand, fingerprint: string, audit: ProposedAuditEvent, hiddenVersion = false): { data: MemoryData; result: ApplyResult } {
    const auditId = key(command.requestId, command.attemptId);
    if (base.attempts.has(auditId)) throw new StorageError('ATTEMPT_ID_REUSED');
    const recordedAt = (this.#options.now ?? (() => new Date().toISOString()))();
    if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) throw new StorageError('INVALID_CLOCK');
    const history = base.audits.get(command.requestId) ?? [];
    const record: AuditRecord = { ...structuredClone(audit), auditId, sequence: history.length + 1, recordedAt,
      ...(audit.outcome === 'ACCEPTED' && command.event.type === 'APPLY_ROUTING' ? { routing: structuredClone(command.event.result) } : {}) };
    const result: ApplyResult = { outcome: audit.outcome, reason: audit.reason, version: hiddenVersion ? null : audit.stateVersion, auditId, replayed: false };
    const data = { ...base, audits: new Map(base.audits), attempts: new Map(base.attempts) };
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
        Object.keys(command).some(k => !['attemptId', 'requestId', 'event', 'snapshots', 'expectedActorId', 'preconditionFailure', 'commandFingerprint'].includes(k))) return deny('INVALID_COMMAND');
    if ((command.expectedActorId !== undefined && !id(command.expectedActorId)) ||
        (command.preconditionFailure !== undefined && !id(command.preconditionFailure)) ||
        (command.commandFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(command.commandFingerprint))) return deny('INVALID_COMMAND');
    if (command.expectedActorId !== undefined && actor.id !== command.expectedActorId) return deny('IDENTITY_CHANGED');
    if (!obj(command.event.request) || command.event.request.requestId !== command.requestId) return deny('REQUEST_SCOPE_MISMATCH');
    if (state) this.#assertSnapshots(state, base.snapshots); // Corrupt stored state/evidence blocks writes.
    const priorReceipt = base.receipts.get(key(command.requestId, command.event.eventId));
    if (priorReceipt && priorReceipt.commandFingerprint !== command.commandFingerprint) return deny('EVENT_ID_REUSED');
    if (command.preconditionFailure !== undefined) return deny(command.preconditionFailure);
    const event = { ...command.event, actor } as WorkflowEvent;
    const transition = transitionWorkflow(state, event);
    if (transition.outcome !== 'ACCEPTED') {
      const update = this.#append(base, command, fingerprint, transition.audit);
      this.#commit(update.data); return structuredClone(update.result);
    }
    // Build all replacement records off to the side. A rejected stage saves only audit.
    try {
      const next = transition.state!;
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
      const evidence = new Map(base.evidence);
      const record = evidenceFromEvent(event);
      if (record) {
        const recordKey = key(command.requestId, record.kind, record.recordId);
        if (evidence.has(recordKey)) return deny('EVIDENCE_ID_REUSED');
        evidence.set(recordKey, record);
      }
      const update = this.#append(base, command, fingerprint, transition.audit);
      const receiptKey = key(command.requestId, event.eventId);
      if (base.receipts.has(receiptKey)) throw new StorageError('RECEIPT_CONFLICT');
      const processed = next.processedEvents.find(item => item.eventId === event.eventId);
      if (!processed) throw new StorageError('MISSING_EVENT_RECEIPT');
      const receipt: EventReceipt = { request: identity(next), eventId: event.eventId,
        fingerprint: processed.fingerprint, workflowVersion: next.version, auditId: update.result.auditId,
        ...(command.commandFingerprint === undefined ? {} : { commandFingerprint: command.commandFingerprint }),
        ...(event.type === 'APPLY_ROUTING' ? { routing: structuredClone(event.result) } : {}) };
      const candidate: MemoryData = { ...update.data, snapshots, evidence, workflows: new Map(base.workflows), receipts: new Map(base.receipts) };
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

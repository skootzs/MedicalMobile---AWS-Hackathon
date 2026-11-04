import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson, createSnapshot, requestPreviewIdentity, SnapshotError } from './snapshots.ts';
import type { Snapshot, SnapshotValidator } from './snapshots.ts';
import type { DesignBrief, PreliminaryScreening, RevisionIdentity } from './routing.ts';
import type { Actor, WorkflowState } from './workflow.ts';
import type { ApplyResult, OrchestratorStore, StoreDependencies, WorkflowCommand } from './storage/requests.ts';

/** Provisional R2 contracts, separate from R4's eventual shared schema. */
export type RequestContent = Pick<DesignBrief, 'title' | 'objective' | 'targetPopulation' | 'requirements'>;
export interface CreateRequestCommand { eventId: string; expectedVersion: 0; content: RequestContent }
export interface CurrentRequestCommand extends RevisionIdentity { eventId: string; expectedVersion: number }
export interface ConfirmRequestCommand extends CurrentRequestCommand {
  screeningId: string;
  decision: 'CONFIRMED' | 'REVISION_REQUESTED';
}
export interface ReviseRequestCommand extends CurrentRequestCommand { content: RequestContent }
/** Internal only: authenticated R3 service context, never a browser route/body. */
export interface ScreeningCommand extends CurrentRequestCommand { screening: PreliminaryScreening }
export interface RequestResult {
  status: 'SUCCESS' | 'DUPLICATE_EVENT' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  requestId: string | null;
  eventId: string | null;
  workflowVersion: number | null;
  request: RevisionIdentity | null;
  auditId: string | null;
}
export interface RequestView {
  requestId: string;
  status: WorkflowState['status'];
  version: number;
  preview: Snapshot;
  screening: PreliminaryScreening | null;
  confirmation: WorkflowState['confirmation'];
  clinicalApprovalRequired: true;
}
export interface RequestServiceDependencies {
  store: OrchestratorStore;
  /** Must be the same trusted identity source as storage. No mock default. */
  resolveActor: StoreDependencies['resolveActor'];
  validateSnapshot: SnapshotValidator;
  newAttemptId?: () => string;
}
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const id = (v: unknown): v is string => text(v) && v === v.trim() && v.length <= 100;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const digest = (v: unknown) => createHash('sha256').update(canonicalizeJson(v), 'utf8').digest('hex');
const equal = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function validContent(v: unknown): v is RequestContent {
  return obj(v) && exactKeys(v, ['title', 'objective', 'targetPopulation', 'requirements']) &&
    [v.title, v.objective, v.targetPopulation].every(text) && Array.isArray(v.requirements) && v.requirements.length > 0 &&
    v.requirements.every(r => obj(r) && exactKeys(r, ['condition', 'action']) && text(r.condition) && text(r.action));
}
type Operation = 'CREATE' | 'CONFIRM' | 'REVISE' | 'SCREEN' | 'INTERPRET';
type Command = CreateRequestCommand | ConfirmRequestCommand | ReviseRequestCommand | ScreeningCommand;
function parse(input: Command, operation: Operation): Command | null {
  try {
    const v: unknown = JSON.parse(canonicalizeJson(input));
    if (!obj(v) || !id(v.eventId)) return null;
    if (operation === 'CREATE') return exactKeys(v, ['eventId', 'expectedVersion', 'content']) && v.expectedVersion === 0 && validContent(v.content) ? v as unknown as CreateRequestCommand : null;
    const common = ['eventId', 'expectedVersion', 'requestId', 'revision', 'snapshotHash'];
    const extra = operation === 'CONFIRM' ? ['screeningId', 'decision'] : operation === 'SCREEN' ? ['screening'] : ['content'];
    if (!exactKeys(v, [...common, ...extra]) || !id(v.requestId) || !positive(v.revision) || !hash(v.snapshotHash) || !positive(v.expectedVersion)) return null;
    if (operation === 'CONFIRM' ? !id(v.screeningId) || !['CONFIRMED', 'REVISION_REQUESTED'].includes(v.decision as string)
      : operation === 'SCREEN' ? !obj(v.screening) || !exactKeys(v.screening, ['requestId', 'revision', 'snapshotHash', 'screeningId', 'status', 'checks'])
      : !validContent(v.content)) return null;
    return v as unknown as Command;
  } catch { return null; }
}
/**
 * Coordinates existing workflow events and immutable snapshots. No routing dispatch,
 * model calls, public callbacks, authentication implementation or durable database.
 */
export class RequestService {
  #deps: RequestServiceDependencies;
  constructor(deps: RequestServiceDependencies) { this.#deps = deps; }
  create(command: CreateRequestCommand, principal: unknown) { return this.#execute('CREATE', command, principal); }
  confirm(command: ConfirmRequestCommand, principal: unknown) { return this.#execute('CONFIRM', command, principal); }
  revise(command: ReviseRequestCommand, principal: unknown) { return this.#execute('REVISE', command, principal); }
  /** No HTTP registration: R3's future authenticated adapter calls these methods. */
  recordScreening(command: ScreeningCommand, principal: unknown) { return this.#execute('SCREEN', command, principal); }
  reviseInterpretation(command: ReviseRequestCommand, principal: unknown) { return this.#execute('INTERPRET', command, principal); }

  async get(requestId: string, principal: unknown): Promise<{ status: 'SUCCESS'; request: RequestView } | { status: 'NOT_FOUND' | 'STORAGE_FAILURE' }> {
    try {
      const actor = await this.#deps.resolveActor(principal, requestId);
      const state = await this.#deps.store.getWorkflow(requestId);
      // Owner-only intake view; reviewer access will have a separate review-context API.
      if (!actor?.roles.includes('PO') || !state || state.ownerId !== actor.id) return { status: 'NOT_FOUND' };
      const preview = await this.#deps.store.getSnapshot({ requestId, revision: state.brief.revision, kind: 'REQUEST_PREVIEW' });
      if (!preview || preview.snapshotHash !== state.brief.snapshotHash) return { status: 'STORAGE_FAILURE' };
      return { status: 'SUCCESS', request: { requestId, status: state.status, version: state.version, preview,
        screening: state.screening, confirmation: state.confirmation, clinicalApprovalRequired: true } };
    } catch { return { status: 'STORAGE_FAILURE' }; }
  }

  async #execute(operation: Operation, input: Command, principal: unknown): Promise<RequestResult> {
    const c = parse(input, operation);
    let requestId: string | null = c && 'requestId' in c ? c.requestId : null;
    const reply = (status: RequestResult['status'], reason: string, stored?: ApplyResult, request: RevisionIdentity | null = null): RequestResult => ({
      status, reason, requestId, eventId: c?.eventId ?? null, workflowVersion: stored?.version ?? null, auditId: stored?.auditId ?? null, request,
    });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      // Creation uses an explicit authenticated creation scope, before there is a resource.
      let actor: Actor | null = await this.#deps.resolveActor(principal, requestId ?? 'request-creation');
      if (!actor || !id(actor.id)) return reply('REJECTED', 'UNAUTHORIZED');
      actor = structuredClone(actor);
      if (operation === 'CREATE') {
        if (!actor.roles.includes('PO')) return reply('REJECTED', 'WRONG_ROLE');
        // Backend-assigned, deterministic idempotency namespace; not a snapshot hash.
        // Stable across retries/processes, unique per verified owner + submission event.
        requestId = `req-${digest({ namespace: 'r2-request-id-v1', ownerId: actor.id, eventId: c.eventId })}`;
      }
      const rid = requestId!;
      const fingerprint = digest({ operation, command: c });
      const receipt = await this.#deps.store.getReceipt(rid, c.eventId);
      const state = await this.#deps.store.getWorkflow(rid);
      const current = c as CurrentRequestCommand;
      const request: RevisionIdentity = { requestId: rid, revision: current.revision, snapshotHash: current.snapshotHash };
      let snapshots: readonly Snapshot[] | undefined;
      let event: WorkflowCommand;
      if (operation === 'CREATE' || operation === 'REVISE' || operation === 'INTERPRET') {
        const content = (c as CreateRequestCommand | ReviseRequestCommand).content;
        const snapshot = createSnapshot({ kind: 'REQUEST_PREVIEW', requestId: rid,
          revision: operation === 'CREATE' ? 1 : current.revision + 1, schemaVersion: '1.0', content }, this.#deps.validateSnapshot);
        const brief = { ...content, ...requestPreviewIdentity(snapshot) };
        snapshots = [snapshot];
        event = { type: operation === 'CREATE' ? 'SUBMIT' : 'REVISE_REQUEST', eventId: c.eventId,
          expectedVersion: c.expectedVersion, request: operation === 'CREATE' ? requestPreviewIdentity(snapshot) : request, brief };
      } else if (operation === 'CONFIRM') {
        const confirmation = c as ConfirmRequestCommand;
        event = { type: 'PO_DECISION', eventId: c.eventId, expectedVersion: c.expectedVersion, request,
          confirmation: { ...request, confirmationId: c.eventId, screeningId: confirmation.screeningId, decision: confirmation.decision } };
      } else {
        event = { type: 'SCREENING_COMPLETED', eventId: c.eventId, expectedVersion: c.expectedVersion, request, screening: (c as ScreeningCommand).screening };
      }
      let failure: string | undefined;
      const internal = operation === 'SCREEN' || operation === 'INTERPRET';
      if (internal ? !actor.roles.includes('DRAFTER') : !actor.roles.includes('PO')) failure = 'WRONG_ROLE';
      else if (operation !== 'CREATE' && !state) failure = 'REQUEST_NOT_FOUND';
      else if (!internal && state && state.ownerId !== actor.id) failure = 'WRONG_OWNER';
      else if (receipt && receipt.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      else if (!receipt) {
        if (operation !== 'CREATE' && state && c.expectedVersion !== state.version) failure = 'VERSION_CONFLICT';
        else if (operation !== 'CREATE' && state && !equal(requestPreviewIdentityFromState(state), request)) failure = 'STALE_REQUEST';
        else if ((operation === 'REVISE' || operation === 'INTERPRET') && state) {
          const { requestId: _id, revision: _rev, snapshotHash: _hash, ...previousContent } = state.brief;
          if (equal(previousContent, (c as ReviseRequestCommand).content)) failure = 'NO_MATERIAL_CHANGE';
        }
      }
      // Store re-resolves identity and invokes workflow guards in its atomic commit.
      const stored = await this.#deps.store.apply({ requestId: rid, event, attemptId: (this.#deps.newAttemptId ?? randomUUID)(),
        expectedActorId: actor.id, commandFingerprint: fingerprint,
        ...(snapshots ? { snapshots } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return reply(['VERSION_CONFLICT', 'STALE_REQUEST'].includes(stored.reason) ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
      const accepted = await this.#deps.store.getReceipt(rid, c.eventId);
      if (!accepted) return reply('STORAGE_FAILURE', 'MISSING_EVENT_RECEIPT');
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'SUCCESS', stored.reason, stored, accepted.request);
    } catch (error) {
      return error instanceof SnapshotError ? reply('REJECTED', 'INVALID_COMMAND') : reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE');
    }
  }
}
function requestPreviewIdentityFromState(state: WorkflowState): RevisionIdentity {
  return { requestId: state.brief.requestId, revision: state.brief.revision, snapshotHash: state.brief.snapshotHash };
}

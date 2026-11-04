import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import { routeDesignBrief } from './routing.ts';
import type { RevisionIdentity, RoutingResult, RoutingReason } from './routing.ts';
import type { Actor } from './workflow.ts';
import type { EventReceipt } from './storage/audit.ts';
import type { ApplyResult, OrchestratorStore, StoreDependencies, WorkflowCommand } from './storage/requests.ts';

/** Provisional R2 application contract; R4 owns the eventual shared schema. */
export interface RoutingCommand extends RevisionIdentity { expectedVersion: number; eventId: string }
export interface RoutingExecutionResult {
  status: 'SUCCESS' | 'NOT_READY' | 'REJECTED' | 'STALE_VERSION' | 'DUPLICATE_EVENT' | 'STORAGE_FAILURE';
  reason: string;
  requestId: string | null;
  eventId: string | null;
  workflowVersion: number | null;
  auditId: string | null;
  /** A committed historical decision on success/retry; eligibility reasons on NOT_READY. */
  routing: RoutingResult | null;
}
export interface RoutingServiceDependencies {
  store: OrchestratorStore;
  resolveActor: StoreDependencies['resolveActor'];
  /** Trusted request visibility policy, shared with the HTTP auth boundary. No allow default. */
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Optional extra restriction. Cannot grant a role prohibited by workflow.ts. */
  authorizeActor?(actor: Readonly<Actor>, requestId: string): boolean | Promise<boolean>;
  newAttemptId?: () => string;
}
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim() && v.length <= 100;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
function parse(input: RoutingCommand): RoutingCommand | null {
  try {
    const c = JSON.parse(canonicalizeJson(input)) as Record<string, unknown>;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== 5 ||
        !Object.keys(c).every(k => ['requestId', 'expectedVersion', 'eventId', 'revision', 'snapshotHash'].includes(k)) ||
        !id(c.requestId) || !id(c.eventId) || !positive(c.expectedVersion) || !positive(c.revision) ||
        typeof c.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.snapshotHash)) return null;
    return c as unknown as RoutingCommand;
  } catch { return null; }
}
const identity = (c: RevisionIdentity): RevisionIdentity => ({ requestId: c.requestId, revision: c.revision, snapshotHash: c.snapshotHash });
const blockedReason = (code: RoutingReason['code'], field: string, message: string): RoutingReason => ({ code, field, message });

function acceptedRouting(receipt: EventReceipt, command: RoutingCommand): RoutingResult {
  const saved = receipt.routing;
  if (!saved || saved.route === 'NOT_READY' || receipt.eventId !== command.eventId || !same(receipt.request, identity(command)) ||
      saved.requestId !== command.requestId || saved.revision !== command.revision || saved.snapshotHash !== command.snapshotHash ||
      !id(saved.screeningId) || !id(saved.confirmationId)) throw Error('Routing receipt integrity failure.');
  return structuredClone(saved);
}

/** Explicit coordinator: no task assignment, model calls, compilation or dispatch. */
export class RoutingService {
  #deps: RoutingServiceDependencies;
  constructor(deps: RoutingServiceDependencies) {
    if (!deps.store || typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function') throw Error('Trusted identity, request access and storage boundaries are required.');
    this.#deps = deps;
  }
  async execute(input: RoutingCommand, principal: unknown): Promise<RoutingExecutionResult> {
    const c = parse(input);
    const reply = (status: RoutingExecutionResult['status'], reason: string, stored?: ApplyResult, routing: RoutingResult | null = null): RoutingExecutionResult => ({
      status, reason, requestId: c?.requestId ?? null, eventId: c?.eventId ?? null,
      workflowVersion: stored?.version ?? null, auditId: stored?.auditId ?? null, routing,
    });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      // Never load private workflow/evidence until request visibility is established.
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      const actor = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !id(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!actor.roles.includes('ORCHESTRATOR') || this.#deps.authorizeActor && await this.#deps.authorizeActor(actor, c.requestId) !== true) return reply('REJECTED', 'WRONG_ROLE');
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor.id }), 'utf8').digest('hex');
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      const state = await this.#deps.store.getWorkflow(c.requestId);
      if (!state) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      if (state.brief.requestId !== c.requestId) return reply('STORAGE_FAILURE', 'REQUEST_SCOPE_MISMATCH');
      let failure: string | undefined;
      let routing: RoutingResult;
      if (receipt?.commandFingerprint === fingerprint) {
        // Reuse the immutable accepted decision, even if the request was later revised.
        routing = acceptedRouting(receipt, c);
      } else {
        const current = identity(state.brief);
        const preview = await this.#deps.store.getSnapshot({ kind: 'REQUEST_PREVIEW', requestId: c.requestId, revision: current.revision });
        const records = await this.#deps.store.listEvidence(c.requestId);
        routing = routeDesignBrief({ currentRevision: current, currentScreeningId: state.screening?.screeningId,
          brief: state.brief, screening: state.screening, confirmation: state.confirmation });
        const extra: RoutingReason[] = [];
        const { requestId: _id, revision: _revision, snapshotHash: _hash, ...content } = state.brief;
        if (!preview || preview.kind !== 'REQUEST_PREVIEW' || preview.requestId !== c.requestId || preview.revision !== current.revision ||
            preview.snapshotHash !== current.snapshotHash || !same(preview.content, content)) {
          extra.push(blockedReason('STALE_EVIDENCE', 'preview', 'The current immutable preview must match the authoritative request content and identity.'));
        }
        // Verify accepted records, not just flags cached on workflow state.
        const screenings = records.filter(r => r.requestId === c.requestId && r.kind === 'SCREENING_COMPLETED' && r.recordId === state.screening?.screeningId &&
          r.event.type === 'SCREENING_COMPLETED' && same(r.event.request, current) && same(r.event.screening, state.screening));
        const confirmations = records.filter(r => r.requestId === c.requestId && r.kind === 'PO_DECISION' && r.recordId === state.confirmation?.confirmationId &&
          r.event.type === 'PO_DECISION' && r.event.actor.id === state.ownerId && same(r.event.request, current) && same(r.event.confirmation, state.confirmation));
        if (screenings.length !== 1) extra.push(blockedReason('CONFLICTING_EVIDENCE', 'screening', 'Exactly one matching accepted screening record is required.'));
        if (confirmations.length !== 1) extra.push(blockedReason('CONFLICTING_EVIDENCE', 'confirmation', 'Exactly one matching accepted owner PO confirmation is required.'));
        if (extra.length) routing = { ...routing, route: 'NOT_READY', reasons: [...(routing.route === 'NOT_READY' ? routing.reasons : []), ...extra] };
        if (receipt) failure = 'EVENT_ID_REUSED';
        else if (state.version !== c.expectedVersion) failure = 'VERSION_CONFLICT';
        else if (!same(current, identity(c))) failure = 'STALE_REQUEST';
        else if (routing.route === 'NOT_READY') failure = 'NOT_READY';
      }
      // Recheck policy after reads. Store identity resolution must also enforce current
      // request membership; it re-resolves actor/roles inside the atomic write boundary.
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      if (this.#deps.authorizeActor && await this.#deps.authorizeActor(actor, c.requestId) !== true) return reply('REJECTED', 'WRONG_ROLE');
      // Receipt and state were read separately. If a concurrent identical command
      // committed between them, replay its original event rather than a stale preflight.
      const latestReceipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
      if (latestReceipt?.commandFingerprint === fingerprint) { routing = acceptedRouting(latestReceipt, c); failure = undefined; }
      else if (latestReceipt) failure = 'EVENT_ID_REUSED';
      const event: WorkflowCommand = { type: 'APPLY_ROUTING', request: identity(c), expectedVersion: c.expectedVersion, eventId: c.eventId, result: routing };
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), event,
        expectedActorId: actor.id, commandFingerprint: fingerprint, ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'ACCEPTED') return reply(stored.replayed ? 'DUPLICATE_EVENT' : 'SUCCESS', stored.reason, stored, routing);
      if (stored.outcome === 'DUPLICATE') return reply('DUPLICATE_EVENT', stored.reason, stored, routing);
      if (stored.reason === 'NOT_READY') return reply('NOT_READY', stored.reason, stored, routing);
      return reply(['VERSION_CONFLICT', 'STALE_REQUEST'].includes(stored.reason) ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

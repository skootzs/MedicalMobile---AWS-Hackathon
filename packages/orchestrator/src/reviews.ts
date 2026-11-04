import { commandEvent, evidenceFailure } from './approvals.ts';
import type { ApprovalCommand } from './approvals.ts';
import { canonicalizeJson } from './snapshots.ts';
import type { Snapshot } from './snapshots.ts';
import { routeDesignBrief, screeningAreas } from './routing.ts';
import type { PreliminaryScreening, RevisionIdentity, RoutingReason } from './routing.ts';
import { transitionWorkflow } from './workflow.ts';
import type { Actor, Role, WorkflowEvent, WorkflowState, WorkflowStatus } from './workflow.ts';
import type { OrchestratorStore, ReviewCandidateSource, StoreDependencies } from './storage/requests.ts';

/** Provisional R2 read contracts; R4 owns eventual shared schemas. */
export const reviewCategories = ['SERVICE_DESIGNER', 'CLINICAL', 'RELEASE'] as const;
export type ReviewCategory = typeof reviewCategories[number];
const pending: Record<ReviewCategory, WorkflowStatus> = {
  SERVICE_DESIGNER: 'NEEDS_SD_REVIEW', CLINICAL: 'WAITING_FOR_CLINICAL_APPROVAL', RELEASE: 'WAITING_FOR_RELEASE_APPROVAL',
};
const roles: Record<ReviewCategory, Role> = { SERVICE_DESIGNER: 'SERVICE_DESIGNER', CLINICAL: 'CLINICIAN', RELEASE: 'RELEASE_APPROVER' };
type WithoutDecision<T> = T extends ApprovalCommand ? Omit<T, 'requestId' | 'type' | 'eventId' | 'decision' | 'note'> : never;
export type DecisionReferences = WithoutDecision<ApprovalCommand>;
export interface ReviewContext {
  category: ReviewCategory;
  requestId: string;
  workflowVersion: number;
  status: WorkflowStatus;
  request: RevisionIdentity;
  eligibility: { eligible: boolean; reasons: readonly string[] };
  /** Reference-only DTOs omit actor IDs, raw workflow internals and historical records. */
  preview: Snapshot | null;
  logicModel: Snapshot | null;
  checker: WorkflowState['checks'];
  clinicalApproval: { eventId: string; logicRevision: number; logicHash: string } | null;
  artifact: WorkflowState['artifact'];
  verification: WorkflowState['verification'];
  screening: PreliminaryScreening | null;
  clarification: { routingReasons: readonly RoutingReason[] } | null;
  unresolvedFindings: readonly { area: typeof screeningAreas[number]; reasons: readonly string[] }[];
  decisionReferences: DecisionReferences | null;
  clinicalApprovalRequired: true;
}
export interface ReviewQueueItem {
  requestId: string;
  category: ReviewCategory;
  workflowVersion: number;
  status: WorkflowStatus;
  request: RevisionIdentity;
}
type Failure = { status: 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'STALE' | 'STORAGE_FAILURE'; reason: string };
export type ReviewContextResult = { status: 'SUCCESS'; context: ReviewContext } | Failure;
export type ReviewQueueResult = { status: 'SUCCESS'; category: ReviewCategory; items: readonly ReviewQueueItem[] } | Failure;
export interface ReviewServiceDependencies {
  store: OrchestratorStore;
  candidates: ReviewCandidateSource;
  resolveActor: StoreDependencies['resolveActor'];
  /** Trusted backend policy: membership/visibility and assignments if available.
   * Required, no permissive default. Use the same policy as the HTTP auth boundary. */
  canAccessRequest(principal: unknown, requestId: string, category: ReviewCategory): boolean | Promise<boolean>;
}
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const identity = (s: WorkflowState): RevisionIdentity => ({ requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash });
const validCategory = (v: unknown): v is ReviewCategory => reviewCategories.includes(v as ReviewCategory);
const validId = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.trim() === v && v.length <= 100;
const allowed = (actor: Actor | null, category: ReviewCategory) => !!actor && validId(actor.id) && Array.isArray(actor.roles) && actor.roles.includes(roles[category]);
const fail = (status: Failure['status'], reason: string): Failure => ({ status, reason });

/** Read-only: no apply(), event receipt, audit write, assignment or job creation. */
export class ReviewService {
  #deps: ReviewServiceDependencies;
  constructor(deps: ReviewServiceDependencies) {
    if (typeof deps.canAccessRequest !== 'function' || typeof deps.resolveActor !== 'function' || typeof deps.candidates?.listReviewCandidates !== 'function') throw Error('Trusted review access, identity and candidate source are required.');
    this.#deps = deps;
  }
  async queue(category: ReviewCategory, principal: unknown): Promise<ReviewQueueResult> {
    if (!validCategory(category)) return fail('INVALID_INPUT', 'INVALID_CATEGORY');
    try {
      // Global scope establishes category eligibility before any candidate enumeration.
      const actor = await this.#deps.resolveActor(principal, 'review-queue');
      if (!allowed(actor, category)) return fail('FORBIDDEN', 'WRONG_ROLE');
      const items: ReviewQueueItem[] = [];
      const ids = [...new Set(await this.#deps.candidates.listReviewCandidates(pending[category]))].sort();
      for (const requestId of ids) {
        const result = await this.context(requestId, category, principal);
        if (result.status === 'STORAGE_FAILURE') return result; // No partial queue on infrastructure failure.
        if (result.status !== 'SUCCESS' || !result.context.eligibility.eligible) continue;
        const c = result.context;
        items.push({ requestId, category, workflowVersion: c.workflowVersion, status: c.status, request: c.request });
      }
      // Earlier items may change while later contexts are assembled. Recheck their
      // visibility and version before returning; this is still not a database read transaction.
      const currentItems: ReviewQueueItem[] = [];
      for (const item of items) {
        if (!await this.#deps.canAccessRequest(principal, item.requestId, category)) continue;
        const current = await this.#deps.store.getWorkflow(item.requestId);
        if (current && current.version === item.workflowVersion && current.status === pending[category] && same(identity(current), item.request)) currentItems.push(item);
      }
      const currentActor = await this.#deps.resolveActor(principal, 'review-queue');
      if (!allowed(currentActor, category) || currentActor!.id !== actor!.id) return fail('FORBIDDEN', 'IDENTITY_CHANGED');
      // A queue is a read-time view, never a lock/reservation or authorization token.
      return { status: 'SUCCESS', category, items: currentItems };
    } catch { return fail('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
  async context(requestId: string, category: ReviewCategory, principal: unknown, expectedVersion?: number): Promise<ReviewContextResult> {
    if (!validId(requestId) || !validCategory(category) || expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) return fail('INVALID_INPUT', 'INVALID_QUERY');
    try {
      // Check access before touching workflow, snapshots or evidence. Hide existence.
      if (!await this.#deps.canAccessRequest(principal, requestId, category)) return fail('NOT_FOUND', 'REQUEST_NOT_FOUND');
      const actor = structuredClone(await this.#deps.resolveActor(principal, requestId));
      if (!allowed(actor, category)) return fail('FORBIDDEN', 'WRONG_ROLE');
      const s = await this.#deps.store.getWorkflow(requestId);
      if (!s) return fail('NOT_FOUND', 'REQUEST_NOT_FOUND');
      if (s.brief.requestId !== requestId) return fail('STORAGE_FAILURE', 'REQUEST_SCOPE_MISMATCH');
      if (expectedVersion !== undefined && s.version !== expectedVersion) return fail('STALE', 'VERSION_CONFLICT');
      if (s.status !== pending[category]) return fail('STALE', 'REVIEW_NOT_PENDING');
      const request = identity(s);
      const preview = await this.#deps.store.getSnapshot({ kind: 'REQUEST_PREVIEW', requestId, revision: request.revision });
      const model = category !== 'SERVICE_DESIGNER' && s.logic ? await this.#deps.store.getSnapshot({ kind: 'LOGIC_MODEL', requestId,
        revision: s.logic.logicRevision, requestPreview: request }) : null;
      const safePreview = preview?.kind === 'REQUEST_PREVIEW' && preview.requestId === requestId && preview.revision === request.revision && preview.snapshotHash === request.snapshotHash ? preview : null;
      const safeModel = model?.kind === 'LOGIC_MODEL' && model.requestId === requestId && model.revision === s.logic?.logicRevision && model.snapshotHash === s.logic.logicHash && same(model.requestPreview, request) ? model : null;
      const safeScreening = s.screening && s.screening.requestId === requestId && s.screening.revision === request.revision && s.screening.snapshotHash === request.snapshotHash ? s.screening : null;
      const records = await this.#deps.store.listEvidence(requestId);
      const reasons: string[] = [];
      if (category === 'SERVICE_DESIGNER') {
        if (!preview || preview.kind !== 'REQUEST_PREVIEW' || preview.snapshotHash !== request.snapshotHash || preview.requestId !== requestId || preview.revision !== request.revision) reasons.push('SNAPSHOT_REQUIRED');
        const screening = records.filter(r => r.kind === 'SCREENING_COMPLETED' && r.requestId === requestId &&
          r.event.type === 'SCREENING_COMPLETED' && same(r.event.request, request) && same(r.event.screening, s.screening));
        const confirmations = records.filter(r => r.kind === 'PO_DECISION' && r.requestId === requestId &&
          r.event.type === 'PO_DECISION' && same(r.event.request, request) && same(r.event.confirmation, s.confirmation));
        if (screening.length !== 1 || confirmations.length !== 1) reasons.push('INTAKE_EVIDENCE_REQUIRED');
        const routed = routeDesignBrief({ currentRevision: request, currentScreeningId: s.screening?.screeningId,
          brief: s.brief, screening: s.screening, confirmation: s.confirmation });
        if (routed.route !== 'NEEDS_SD_REVIEW' || !same(routed, s.routing)) reasons.push('SD_ROUTING_REQUIRED');
      }
      let command: ApprovalCommand | null = null;
      if (category !== 'SERVICE_DESIGNER') {
        // Missing references remain empty/invalid internally; never invent hashes or expose a usable command for them.
        const base = { requestId, expectedVersion: s.version, requestRevision: request.revision, requestSnapshotHash: request.snapshotHash,
          logicRevision: s.logic?.logicRevision ?? 0, logicHash: s.logic?.logicHash ?? '', eventId: this.#probeEventId(s), decision: 'APPROVE' as const };
        command = category === 'CLINICAL' ? { ...base, type: 'CLINICAL_DECISION', checkerReportId: s.checks?.reportId ?? '' }
          : { ...base, type: 'RELEASE_DECISION', clinicalApprovalEventId: s.clinicalApproval?.eventId ?? '', compilationId: s.artifact?.compilationId ?? '',
              artifactHash: s.artifact?.artifactHash ?? '', verificationId: s.verification?.verificationId ?? '', verificationReportHash: s.verification?.reportHash ?? '' };
        // The same evidence bindings used on decision submission, with no duplicated approval rules.
        const evidence = evidenceFailure(command, s, preview, model, records);
        if (evidence) reasons.push(evidence);
        const proposal = transitionWorkflow(s, { ...commandEvent(command, s.verification ?? undefined), actor: actor! } as WorkflowEvent);
        if (proposal.outcome !== 'ACCEPTED') reasons.push(proposal.audit.reason);
      }
      // Detect changes during the multi-read view, including access/role revocation.
      const latest = await this.#deps.store.getWorkflow(requestId);
      if (!latest || latest.version !== s.version || !same(identity(latest), request)) return fail('STALE', 'VERSION_CONFLICT');
      if (!await this.#deps.canAccessRequest(principal, requestId, category)) return fail('NOT_FOUND', 'REQUEST_NOT_FOUND');
      const latestActor = await this.#deps.resolveActor(principal, requestId);
      if (!allowed(latestActor, category) || latestActor!.id !== actor!.id) return fail('FORBIDDEN', 'IDENTITY_CHANGED');
      const eligible = reasons.length === 0;
      let decisionReferences: DecisionReferences | null = null;
      if (eligible && command) {
        const { requestId: _id, type: _type, eventId: _event, decision: _decision, note: _note, ...refs } = command;
        decisionReferences = refs;
      }
      return { status: 'SUCCESS', context: {
        category, requestId, workflowVersion: s.version, status: s.status, request,
        eligibility: { eligible, reasons: [...new Set(reasons)] },
        preview: category === 'SERVICE_DESIGNER' ? safePreview : null,
        logicModel: category === 'SERVICE_DESIGNER' ? null : safeModel,
        checker: category === 'SERVICE_DESIGNER' ? null : s.checks,
        clinicalApproval: category === 'RELEASE' && s.clinicalApproval ? { eventId: s.clinicalApproval.eventId,
          logicRevision: s.clinicalApproval.logicRevision, logicHash: s.clinicalApproval.logicHash } : null,
        artifact: category === 'RELEASE' ? s.artifact : null,
        verification: category === 'RELEASE' ? s.verification : null,
        screening: category === 'SERVICE_DESIGNER' ? safeScreening : null,
        clarification: category === 'SERVICE_DESIGNER' ? { routingReasons: s.routing?.reasons ?? [] } : null,
        unresolvedFindings: safeScreening ? screeningAreas.filter(area => safeScreening.checks[area].outcome !== 'CLEAR')
          .map(area => ({ area, reasons: safeScreening.checks[area].reasons })) : [],
        decisionReferences, clinicalApprovalRequired: true,
      } };
    } catch { return fail('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
  #probeEventId(s: WorkflowState): string {
    let index = 0;
    while (s.processedEvents.some(e => e.eventId === `review-read-probe-${index}`)) index++;
    return `review-read-probe-${index}`;
  }
}

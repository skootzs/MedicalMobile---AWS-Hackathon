import { createHash, randomUUID } from 'node:crypto';
import { canonicalizeJson } from './snapshots.ts';
import { CHECKER_GATE_POLICY, checkerCompleted, checkerId, checkerPassed, checkerSame, checkerVersionNumber, makeCheckerInvocation, parseCheckerReport, reportMatchesInvocation } from './checker-contracts.ts';
import type { AcceptedCheckerResult, CheckerInvocation, CheckerReport, CheckerTarget } from './checker-contracts.ts';
import type { RevisionIdentity } from './routing.ts';
import type { Actor, LogicIdentity } from './workflow.ts';
import type { ApplyResult, StoreDependencies } from './storage/requests.ts';
import type { CheckerStore } from './storage/checkers.ts';
import type { EventReceipt } from './storage/audit.ts';

export interface AuthorizeCheckCommand extends RevisionIdentity, LogicIdentity { eventId: string; expectedVersion: number }
export interface CheckerResultCommand extends AuthorizeCheckCommand { invocationId: string; report: CheckerReport }
export interface CheckerDependencies {
  store: CheckerStore;
  resolveActor: StoreDependencies['resolveActor'];
  canAccessRequest(principal: unknown, requestId: string): boolean | Promise<boolean>;
  /** Trusted backend target configuration, never supplied by the result caller. */
  checker: CheckerTarget;
  authorizeWorker?(actor: Readonly<Actor>, invocation: CheckerInvocation): boolean | Promise<boolean>;
  newAttemptId?: () => string;
}
export interface CheckerIngestionResult {
  status: 'ACCEPTED' | 'DUPLICATE_EVENT' | 'BLOCKED' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  result: AcceptedCheckerResult | null;
  workflowVersion: number | null;
  auditId: string | null;
  attemptAuditId: string | null;
}
export interface CheckerAuthorizationResult {
  status: 'AUTHORIZED' | 'DUPLICATE_EVENT' | 'REJECTED' | 'STALE_VERSION' | 'STORAGE_FAILURE';
  reason: string;
  invocation: CheckerInvocation | null;
  auditId: string | null;
}
const identity = (c: RevisionIdentity): RevisionIdentity => ({ requestId: c.requestId, revision: c.revision, snapshotHash: c.snapshotHash });
const logic = (c: LogicIdentity): LogicIdentity => ({ logicRevision: c.logicRevision, logicHash: c.logicHash });
function parse<T extends AuthorizeCheckCommand>(raw: T, extra: string[]): T | null {
  try {
    const c = JSON.parse(canonicalizeJson(raw)) as Record<string, unknown>, fields = ['requestId', 'eventId', 'expectedVersion', 'revision', 'snapshotHash', 'logicRevision', 'logicHash', ...extra];
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== fields.length || !Object.keys(c).every(k => fields.includes(k)) ||
        !checkerId(c.requestId) || !checkerId(c.eventId) || !checkerVersionNumber(c.expectedVersion) || !checkerVersionNumber(c.revision) || !checkerVersionNumber(c.logicRevision) ||
        typeof c.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.snapshotHash) || typeof c.logicHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.logicHash)) return null;
    return c as unknown as T;
  } catch { return null; }
}
const stale = (reason: string) => ['VERSION_CONFLICT', 'STALE_REQUEST', 'STALE_LOGIC', 'STALE_CHECKER_INVOCATION'].includes(reason);
/** Internal metadata authorization and result ingestion only. No checker execution or HTTP callback. */
export class CheckerResultService {
  #deps: CheckerDependencies;
  constructor(deps: CheckerDependencies) {
    if (!deps.store || typeof deps.store.authorizeChecker !== 'function' || typeof deps.resolveActor !== 'function' || typeof deps.canAccessRequest !== 'function' ||
        !deps.checker || ![deps.checker.checkerActorId, deps.checker.checkerId, deps.checker.checkerVersion].every(checkerId)) throw Error('Trusted checker identity, target configuration, visibility and storage are required.');
    this.#deps = deps;
  }
  async authorize(input: AuthorizeCheckCommand, principal: unknown): Promise<CheckerAuthorizationResult> {
    const c = parse(input, []);
    const reply = (status: CheckerAuthorizationResult['status'], reason: string, stored?: ApplyResult, invocation: CheckerInvocation | null = null): CheckerAuthorizationResult => ({ status, reason, invocation, auditId: stored?.auditId ?? null });
    if (!c) return reply('REJECTED', 'INVALID_COMMAND');
    try {
      const actor = await this.#deps.resolveActor(principal, c.requestId);
      if (!actor || !checkerId(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      const invocation = makeCheckerInvocation({ requestId: c.requestId, requestPreview: identity(c), logic: logic(c), workflowVersion: c.expectedVersion, eventId: c.eventId, ...this.#deps.checker });
      const stored = await this.#deps.store.authorizeChecker({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), expectedActorId: actor.id, invocation }, principal);
      if (stored.outcome === 'REJECTED') return reply(stale(stored.reason) ? 'STALE_VERSION' : 'REJECTED', stored.reason, stored);
      const saved = await this.#deps.store.getCheckerInvocation(c.requestId, invocation.invocationId);
      if (!saved || !checkerSame(saved, invocation)) return reply('STORAGE_FAILURE', 'CHECKER_INVOCATION_INTEGRITY');
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'AUTHORIZED', stored.reason, stored, saved);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
  async #accepted(c: CheckerResultCommand, receipt: EventReceipt): Promise<AcceptedCheckerResult> {
    const saved = await this.#deps.store.getCheckerReport(c.requestId, c.report.reportId);
    if (!saved || saved.eventId !== c.eventId || saved.invocation.invocationId !== c.invocationId || saved.invocation.workflowVersion !== c.expectedVersion ||
        !checkerSame(saved.report, c.report) || !checkerSame(saved.invocation.requestPreview, identity(c)) || !checkerSame(saved.invocation.logic, logic(c)) || !checkerSame(receipt.checkerResult, saved)) throw Error('Checker receipt integrity failure.');
    return saved;
  }
  async ingest(input: CheckerResultCommand, principal: unknown): Promise<CheckerIngestionResult> {
    const c = parse(input, ['invocationId', 'report']);
    const reply = (status: CheckerIngestionResult['status'], reason: string, stored?: ApplyResult, result: AcceptedCheckerResult | null = null, receipt?: EventReceipt): CheckerIngestionResult => ({
      status, reason, result, workflowVersion: result?.workflowVersion ?? stored?.version ?? null, auditId: receipt?.auditId ?? stored?.auditId ?? null, attemptAuditId: stored?.auditId ?? null,
    });
    if (!c || !checkerId(c.invocationId)) return reply('REJECTED', 'INVALID_COMMAND');
    const report = parseCheckerReport(c.report);
    if (!report) return reply('REJECTED', 'INVALID_CHECKER_REPORT');
    try {
      const actor: Actor | null = structuredClone(await this.#deps.resolveActor(principal, c.requestId));
      if (!actor || !checkerId(actor.id) || !Array.isArray(actor.roles)) return reply('REJECTED', 'UNAUTHORIZED');
      if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
      let failure = actor.roles.includes('CHECKER') ? undefined : 'WRONG_ROLE';
      const fingerprint = createHash('sha256').update(canonicalizeJson({ command: c, actorId: actor.id })).digest('hex');
      let accepted: AcceptedCheckerResult | undefined;
      let invocation: CheckerInvocation | null = null;
      if (!failure) {
        invocation = await this.#deps.store.getCheckerInvocation(c.requestId, c.invocationId);
        const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (!invocation) failure = 'CHECKER_INVOCATION_REQUIRED';
        else if (actor.id !== invocation.checkerActorId || this.#deps.authorizeWorker && await this.#deps.authorizeWorker(actor, invocation) !== true) failure = 'WORKER_NOT_AUTHORIZED';
        else if (receipt?.commandFingerprint === fingerprint) accepted = await this.#accepted(c, receipt);
        else {
          const s = await this.#deps.store.getWorkflow(c.requestId);
          if (receipt) failure = 'EVENT_ID_REUSED';
          else if (!s || s.brief.requestId !== c.requestId) failure = 'REQUEST_NOT_FOUND';
          else if (s.version !== c.expectedVersion || invocation.workflowVersion !== c.expectedVersion) failure = 'VERSION_CONFLICT';
          else if (!checkerSame(identity(s.brief), identity(c)) || !checkerSame(invocation.requestPreview, identity(c))) failure = 'STALE_REQUEST';
          else if (!checkerSame(s.logic, logic(c)) || !checkerSame(invocation.logic, logic(c))) failure = 'STALE_LOGIC';
          else if (s.status !== 'WAITING_FOR_LOGIC_CHECKS') failure = 'WRONG_STATE';
          else if (!reportMatchesInvocation(report, invocation)) failure = 'CHECKER_EVIDENCE_MISMATCH';
          else {
            const model = await this.#deps.store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: c.requestId, revision: c.logicRevision, requestPreview: identity(c) });
            if (!model || model.kind !== 'LOGIC_MODEL' || model.snapshotHash !== c.logicHash || model.requestId !== c.requestId || !checkerSame(model.requestPreview, identity(c))) failure = 'SNAPSHOT_REQUIRED';
            else if (!checkerCompleted(report)) failure = report.outcome === 'UNAVAILABLE' ? 'CHECKER_UNAVAILABLE' : 'CHECKER_INCOMPLETE';
            else accepted = { invocation, report, eventId: c.eventId, workflowVersion: c.expectedVersion + 1, passed: checkerPassed(report), gatePolicyVersion: CHECKER_GATE_POLICY };
          }
        }
        if (!await this.#deps.canAccessRequest(principal, c.requestId)) return reply('REJECTED', 'REQUEST_NOT_FOUND');
        const latestActor = await this.#deps.resolveActor(principal, c.requestId);
        if (!latestActor || latestActor.id !== actor.id || !latestActor.roles.includes('CHECKER')) failure = 'IDENTITY_CHANGED';
        if (invocation && this.#deps.authorizeWorker && await this.#deps.authorizeWorker(latestActor ?? actor, invocation) !== true) failure = 'WORKER_NOT_AUTHORIZED';
        const latest = await this.#deps.store.getReceipt(c.requestId, c.eventId);
        if (latest?.commandFingerprint === fingerprint && !['IDENTITY_CHANGED', 'WORKER_NOT_AUTHORIZED', 'CHECKER_INVOCATION_REQUIRED'].includes(failure ?? '')) { accepted = await this.#accepted(c, latest); failure = undefined; }
        else if (latest && latest.commandFingerprint !== fingerprint) failure = 'EVENT_ID_REUSED';
      }
      const stored = await this.#deps.store.apply({ requestId: c.requestId, attemptId: (this.#deps.newAttemptId ?? randomUUID)(), commandFingerprint: fingerprint, expectedActorId: actor.id,
        event: { type: 'LOGIC_CHECKED', eventId: c.eventId, expectedVersion: c.expectedVersion, request: identity(c), ...logic(c), reportId: report.reportId, passed: accepted?.passed ?? false, invocationId: c.invocationId },
        ...(accepted ? { checkerResult: accepted } : {}), ...(invocation && reportMatchesInvocation(report, invocation) ? { checkerAttempt: report } : {}), ...(failure ? { preconditionFailure: failure } : {}) }, principal);
      if (stored.outcome === 'REJECTED') return reply(stale(stored.reason) ? 'STALE_VERSION' : ['CHECKER_UNAVAILABLE', 'CHECKER_INCOMPLETE'].includes(stored.reason) ? 'BLOCKED' : 'REJECTED', stored.reason, stored);
      const receipt = await this.#deps.store.getReceipt(c.requestId, c.eventId); if (!receipt) return reply('STORAGE_FAILURE', 'CHECKER_RECEIPT_INTEGRITY');
      const saved = await this.#accepted(c, receipt);
      return reply(stored.outcome === 'DUPLICATE' || stored.replayed ? 'DUPLICATE_EVENT' : 'ACCEPTED', saved.passed ? 'CHECKS_PASSED' : 'CHECKS_BLOCKED', stored, saved, receipt);
    } catch { return reply('STORAGE_FAILURE', 'SERVICE_UNAVAILABLE'); }
  }
}

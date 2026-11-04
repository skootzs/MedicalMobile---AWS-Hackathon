/** TEST ONLY: exact opaque session identities and fictional report fixtures. No clinical algorithms. */
import assert from 'node:assert/strict';
import { CheckerResultService } from '../../src/checkers.ts';
import type { AuthorizeCheckCommand, CheckerDependencies, CheckerResultCommand } from '../../src/checkers.ts';
import type { CheckerAdapter, CheckerInvocation, CheckerReport } from '../../src/checker-contracts.ts';
import type { CheckerStore } from '../../src/storage/checkers.ts';
import type { LogicModelSnapshot } from '../../src/snapshots.ts';
import type { Actor } from '../../src/workflow.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { DraftingCallbackService } from '../../src/callbacks.ts';
import { ReviewService } from '../../src/reviews.ts';
import { jobFixture, recordedJob } from './job-fixtures.ts';
import { FictionalLogicValidation } from './callback-fixtures.ts';
import { model } from './approval-fixtures.ts';
import { resolveReviewActor } from './review-fixtures.ts';
import { wrapStore } from './api-fixtures.ts';
export class FictionalChecker implements CheckerAdapter {
  readonly changes: Partial<CheckerReport>;
  constructor(changes: Partial<CheckerReport> = {}) { this.changes = changes; }
  async check(invocation: CheckerInvocation, _model: LogicModelSnapshot): Promise<CheckerReport> {
    return { reportId: 'fictional-formal-report', resultId: 'fictional-formal-result', requestId: invocation.requestId,
      requestPreview: { ...invocation.requestPreview }, logic: { ...invocation.logic }, invocationId: invocation.invocationId,
      checkerId: invocation.checkerId, checkerVersion: invocation.checkerVersion, outcome: 'PASS', findings: [], references: ['fictional-training-source'], ...this.changes };
  }
}
export function checkerFixture(options: Partial<InMemoryOptions> = {}) {
  const r3 = Object.freeze({ session: 'fictional-r3-session' }), r4 = Object.freeze({ session: 'fictional-r4-session' });
  const other = Object.freeze({ session: 'fictional-other-checker' }), checkerClinician = Object.freeze({ session: 'fictional-checker-as-clinician' });
  const actors = new Map<unknown, Actor>([[r3, { id: 'fictional-r3-worker', roles: ['DRAFTER'] }], [r4, { id: 'fictional-r4-checker-service', roles: ['CHECKER'] }],
    [other, { id: 'fictional-other-checker-service', roles: ['CHECKER'] }], [checkerClinician, { id: 'fictional-r4-checker-service', roles: ['CLINICIAN'] }]]);
  const resolveActor = (p: unknown) => actors.get(p) ?? resolveReviewActor(p);
  const f = jobFixture({ ...options, resolveActor: options.resolveActor ?? resolveActor });
  const canAccessRequest: CheckerDependencies['canAccessRequest'] = (p, id) => id === 'fictional-001' && (actors.has(p) || f.deps.canAccessRequest(p, id));
  const deps: CheckerDependencies = { store: f.db, resolveActor, canAccessRequest,
    checker: { checkerActorId: 'fictional-r4-checker-service', checkerId: 'fictional-r4-checker', checkerVersion: 'fixture-v1' } };
  const reviews = new ReviewService({ store: f.db, candidates: f.db, resolveActor, canAccessRequest: (p, id) => canAccessRequest(p, id) });
  return { ...f, checkerDeps: deps, resolveActor, canAccessRequest, r3, r4, other, checkerClinician, service: new CheckerResultService(deps), reviews };
}
export async function awaitingCheck(f = checkerFixture()) {
  const drafting = await recordedJob(f), s = (await f.db.getWorkflow('fictional-001'))!;
  const callbacks = new DraftingCallbackService({ store: f.db, resolveActor: f.resolveActor, canAccessRequest: f.canAccessRequest, validation: new FictionalLogicValidation() });
  const callback = await callbacks.ingest({ requestId: s.brief.requestId, eventId: 'fictional-model-result', jobId: drafting.job.jobId,
    expectedVersion: s.version, sourceWorkflowVersion: drafting.job.sourceWorkflowVersion, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash,
    schemaVersion: '1.0', logicModel: model(s).content }, f.r3); assert.equal(callback.status, 'ACCEPTED');
  const current = (await f.db.getWorkflow('fictional-001'))!;
  const command: AuthorizeCheckCommand = { requestId: current.brief.requestId, revision: current.brief.revision, snapshotHash: current.brief.snapshotHash,
    logicRevision: current.logic!.logicRevision, logicHash: current.logic!.logicHash, expectedVersion: current.version, eventId: 'fictional-authorize-check' };
  return { ...f, s: current, command, callback };
}
export async function currentCheck(f = checkerFixture(), changes: Partial<CheckerReport> = {}) {
  const a = await awaitingCheck(f), auth = await a.service.authorize(a.command, 'backend'); assert.equal(auth.status, 'AUTHORIZED', auth.reason);
  const snapshot = await a.db.getSnapshot({ kind: 'LOGIC_MODEL', requestId: a.command.requestId, revision: a.command.logicRevision, requestPreview: auth.invocation!.requestPreview });
  if (snapshot?.kind !== 'LOGIC_MODEL') throw Error('fixture');
  const report = await new FictionalChecker(changes).check(auth.invocation!, snapshot);
  const c: CheckerResultCommand = { ...a.command, eventId: 'fictional-checker-result', invocationId: auth.invocation!.invocationId, report };
  return { ...a, invocation: auth.invocation!, report, c };
}
export function wrapCheckerStore(db: CheckerStore, changes: Partial<CheckerStore>): CheckerStore {
  return { ...wrapStore(db, {}), authorizeChecker: (i, p) => db.authorizeChecker(i, p), getCheckerInvocation: (id, inv) => db.getCheckerInvocation(id, inv),
    getCheckerReport: (id, report) => db.getCheckerReport(id, report), ...changes };
}

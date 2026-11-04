import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckerResultService } from '../src/checkers.ts';
import type { CheckerResultCommand } from '../src/checkers.ts';
import type { CheckerReport } from '../src/checker-contracts.ts';
import { checkerPassed, parseCheckerReport, validInvocation } from '../src/checker-contracts.ts';
import { ApprovalService } from '../src/approvals.ts';
import type { ApprovalCommand } from '../src/approvals.ts';
import { createLocalApi } from '../src/server.ts';
import { checkerFixture, awaitingCheck, currentCheck, wrapCheckerStore } from './helpers/checker-fixtures.ts';
import { command, model, preview } from './helpers/approval-fixtures.ts';
import { logicModelIdentity, requestPreviewIdentity } from '../src/snapshots.ts';

const warning = { id: 'fictional-finding', code: 'TRAINING_REFERENCE', severity: 'WARNING' as const, blocking: false,
  message: 'Fictional source reference requires human clarification.', references: ['fictional-training-source'] };
async function clinical(f: Awaited<ReturnType<typeof currentCheck>>, principal: unknown = 'clinic') {
  const s = (await f.db.getWorkflow(f.c.requestId))!;
  const c: ApprovalCommand = { type: 'CLINICAL_DECISION', eventId: 'fictional-clinical-decision', expectedVersion: s.version,
    requestId: f.c.requestId, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    ...s.logic!, checkerReportId: f.report.reportId, decision: 'APPROVE' };
  return new ApprovalService({ store: f.db, resolveActor: f.resolveActor }).execute(c, principal);
}
async function revise(f: Awaited<ReturnType<typeof currentCheck>>, kind: 'request' | 'logic') {
  const s = (await f.db.getWorkflow(f.c.requestId))!;
  const snapshot = kind === 'request' ? preview(2) : model(s, 2);
  const cmd = kind === 'request' ? command(s, { type: 'REVISE_REQUEST', brief: { ...snapshot.content, ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] })
    : command(s, { type: 'REVISE_LOGIC', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] });
  const r = await f.db.apply(cmd, kind === 'request' ? 'po' : 'ai'); assert.equal(r.outcome, 'ACCEPTED', r.reason);
}

test('formal checker invocation is stored without advancing state or executing a worker', async () => {
  const f = await awaitingCheck(), before = await f.db.getWorkflow(f.command.requestId);
  const r = await f.service.authorize(f.command, 'backend'); assert.equal(r.status, 'AUTHORIZED');
  assert.ok(validInvocation(r.invocation)); assert.deepEqual(await f.db.getWorkflow(f.command.requestId), before);
  assert.deepEqual(await f.db.getCheckerInvocation(f.command.requestId, r.invocation!.invocationId), r.invocation);
  const audit = await f.db.listAudit(f.command.requestId); assert.deepEqual(audit.at(-1)?.checkerInvocation, r.invocation);
});
test('only orchestrator may authorize invocation', async () => {
  const f = await awaitingCheck(); const r = await f.service.authorize(f.command, f.r4);
  assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'WRONG_ROLE');
});
test('invocation authorization is idempotent', async () => {
  const f = await awaitingCheck(); const a = await f.service.authorize(f.command, 'backend'), b = await f.service.authorize(f.command, 'backend');
  assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.invocation, a.invocation);
});
test('cannot authorize a second invocation for the same proposal', async () => {
  const f = await currentCheck(); const r = await f.service.authorize({ ...f.command, eventId: 'another-invocation' }, 'backend');
  assert.equal(r.reason, 'CHECKER_INVOCATION_ALREADY_EXISTS');
});
test('changed invocation authorization event is rejected', async () => {
  const f = await currentCheck(); const r = await f.service.authorize({ ...f.command, logicHash: 'a'.repeat(64) }, 'backend');
  assert.equal(r.reason, 'EVENT_ID_REUSED');
});
test('stale invocation version rejected', async () => {
  const f = await awaitingCheck(); const r = await f.service.authorize({ ...f.command, expectedVersion: f.command.expectedVersion - 1 }, 'backend');
  assert.equal(r.status, 'STALE_VERSION');
});
test('invocation transaction failure leaves no metadata or receipt', async () => {
  let fail = false; const f = await awaitingCheck(checkerFixture({ testFaults: { beforeCommit() { if (fail) throw Error('fictional'); } } }));
  const before = await f.db.listAudit(f.command.requestId); fail = true;
  assert.equal((await f.service.authorize(f.command, 'backend')).status, 'STORAGE_FAILURE'); fail = false;
  assert.equal(await f.db.getReceipt(f.command.requestId, f.command.eventId), null);
  assert.deepEqual(await f.db.listAudit(f.command.requestId), before);
});
test('authoritative passing result moves through LOGIC_CHECKED into clinical review', async () => {
  const f = await currentCheck(); const r = await f.service.ingest(f.c, f.r4); assert.equal(r.status, 'ACCEPTED');
  assert.equal(r.reason, 'CHECKS_PASSED'); assert.deepEqual(r.result?.report, f.report);
  const s = (await f.db.getWorkflow(f.c.requestId))!;
  assert.equal(s.status, 'WAITING_FOR_CLINICAL_APPROVAL'); assert.equal(s.version, f.c.expectedVersion + 1);
  assert.equal(s.checks?.invocationId, f.invocation.invocationId); assert.equal(s.clinicalApproval, null); assert.equal(s.releaseApproval, null);
  assert.deepEqual(await f.db.getCheckerReport(f.c.requestId, f.report.reportId), r.result);
  const evidence = await f.db.listEvidence(f.c.requestId); assert.deepEqual(evidence.find(e => e.recordId === f.report.reportId)?.checkerResult, r.result);
});
test('formal completion is distinct from earlier admission validation', async () => {
  const f = await currentCheck(); const s = (await f.db.getWorkflow(f.c.requestId))!;
  assert.equal(s.checks, null); assert.equal(s.status, 'WAITING_FOR_LOGIC_CHECKS');
  const q = await f.reviews.queue('CLINICAL', 'clinic'); assert.equal(q.status, 'SUCCESS'); if (q.status === 'SUCCESS') assert.deepEqual(q.items, []);
  assert.equal((await clinical(f)).status, 'REJECTED');
});
for (const changes of [
  { outcome: 'FAIL' as const, findings: [{ ...warning, severity: 'ERROR' as const, blocking: true }] },
  { outcome: 'ERROR' as const }, { findings: [warning] }, { findings: [{ ...warning, severity: 'INFO' as const, blocking: true }] },
  { findings: [{ ...warning, severity: 'ERROR' as const, blocking: false }] },
]) test(`blocking report ${JSON.stringify(changes)} remains inspectable but never approval eligible`, async () => {
  const f = await currentCheck(checkerFixture(), changes), r = await f.service.ingest(f.c, f.r4);
  assert.equal(r.status, 'ACCEPTED'); assert.equal(r.reason, 'CHECKS_BLOCKED'); assert.equal(r.result?.passed, false);
  assert.equal((await f.db.getWorkflow(f.c.requestId))?.status, 'FAILED');
  const q = await f.reviews.queue('CLINICAL', 'clinic'); if (q.status !== 'SUCCESS') throw Error(q.reason); assert.deepEqual(q.items, []);
  const ctx = await f.reviews.context(f.c.requestId, 'CLINICAL', 'clinic'); if (ctx.status !== 'SUCCESS') throw Error(ctx.reason);
  assert.equal(ctx.context.eligibility.eligible, false); assert.equal(ctx.context.decisionReferences, null);
  assert.ok(ctx.context.eligibility.reasons.includes('CHECKER_BLOCKING_FINDINGS')); assert.deepEqual(ctx.context.checkerReport, f.report);
  assert.equal((await clinical(f)).status, 'REJECTED');
});
for (const outcome of ['UNAVAILABLE', 'INCOMPLETE'] as const) test(`${outcome} result does not complete checks and preserves attempt audit`, async () => {
  const f = await currentCheck(checkerFixture(), { outcome }), before = await f.db.getWorkflow(f.c.requestId);
  const r = await f.service.ingest(f.c, f.r4); assert.equal(r.status, 'BLOCKED'); assert.equal(r.result, null);
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before); assert.equal(await f.db.getCheckerReport(f.c.requestId, f.report.reportId), null);
  assert.deepEqual((await f.db.listAudit(f.c.requestId)).at(-1)?.checkerAttempt, f.report);
  const changed = { ...f.c, report: { ...f.report, outcome: 'PASS' as const } };
  assert.equal((await f.service.ingest(changed, f.r4)).reason, 'EVENT_ID_REUSED');
  assert.equal((await f.service.ingest(f.c, f.r4)).status, 'BLOCKED');
  assert.equal((await f.service.ingest({ ...changed, eventId: 'new-completed-event' }, f.r4)).status, 'ACCEPTED');
});
for (const who of ['none', 'role-forgery', 'other', 'r3', 'clinic', 'checker']) test(`untrusted/wrong service ${who} cannot submit`, async () => {
  const f = await currentCheck(); const principals: Record<string, unknown> = { none: null, 'role-forgery': { session: 'fictional-r4-session', roles: ['CHECKER'], trusted: true }, other: f.other, r3: f.r3, clinic: 'clinic', checker: 'checker' };
  const before = await f.db.getWorkflow(f.c.requestId); assert.equal((await f.service.ingest(f.c, principals[who])).status, 'REJECTED');
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
});
for (const patch of [ { invocationId: 'unknown' }, { requestId: 'unrelated-request' }, { revision: 2 }, { snapshotHash: 'a'.repeat(64) },
  { logicRevision: 2 }, { logicHash: 'a'.repeat(64) }, { expectedVersion: 1 } ]) test(`wrong current command identity ${Object.keys(patch)[0]} rejected`, async () => {
  const f = await currentCheck(), before = await f.db.getWorkflow(f.c.requestId);
  const r = await f.service.ingest({ ...f.c, ...patch }, f.r4); assert.notEqual(r.status, 'ACCEPTED'); assert.notEqual(r.status, 'DUPLICATE_EVENT');
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
});
for (const patch of [ { requestId: 'unrelated-request' }, { invocationId: 'other-invocation' }, { checkerId: 'other-checker' },
  { checkerVersion: 'other-version' }, { logic: { logicRevision: 2, logicHash: 'a'.repeat(64) } } ]) test(`mismatched report provenance ${Object.keys(patch)[0]} rejected`, async () => {
  const f = await currentCheck(), before = await f.db.getWorkflow(f.c.requestId);
  assert.equal((await f.service.ingest({ ...f.c, report: { ...f.report, ...patch } }, f.r4)).status, 'REJECTED');
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
});
for (const kind of ['request', 'logic'] as const) test(`superseded ${kind} result rejected and old evidence excluded`, async () => {
  const f = await currentCheck(); await revise(f, kind);
  const before = await f.db.getWorkflow(f.c.requestId), r = await f.service.ingest(f.c, f.r4);
  assert.equal(r.status, 'STALE_VERSION'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
  const q = await f.reviews.queue('CLINICAL', 'clinic'); if (q.status !== 'SUCCESS') throw Error(q.reason); assert.deepEqual(q.items, []);
});
test('identical accepted retry returns original result and does not duplicate records', async () => {
  const f = await currentCheck(), a = await f.service.ingest(f.c, f.r4), before = await f.db.getWorkflow(f.c.requestId);
  const b = await f.service.ingest(f.c, f.r4); assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.result, a.result); assert.equal(b.auditId, a.auditId);
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
  assert.equal((await f.db.listEvidence(f.c.requestId)).filter(e => e.kind === 'LOGIC_CHECKED').length, 1);
});
test('accepted retry after revision is historical and never restores old proposal', async () => {
  const f = await currentCheck(), a = await f.service.ingest(f.c, f.r4); await revise(f, 'logic');
  const before = await f.db.getWorkflow(f.c.requestId), b = await f.service.ingest(f.c, f.r4);
  assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.result, a.result); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
});
test('changed payload under accepted event ID cannot overwrite report', async () => {
  const f = await currentCheck(), a = await f.service.ingest(f.c, f.r4);
  const r = await f.service.ingest({ ...f.c, report: { ...f.report, findings: [warning] } }, f.r4);
  assert.equal(r.reason, 'EVENT_ID_REUSED'); assert.deepEqual(await f.db.getCheckerReport(f.c.requestId, f.report.reportId), a.result);
});
test('different event cannot replace accepted checker result', async () => {
  const f = await currentCheck(), a = await f.service.ingest(f.c, f.r4);
  const r = await f.service.ingest({ ...f.c, eventId: 'other-result', report: { ...f.report, reportId: 'other-report', outcome: 'FAIL' } }, f.r4);
  assert.equal(r.status, 'STALE_VERSION'); assert.deepEqual(await f.db.getCheckerReport(f.c.requestId, f.report.reportId), a.result);
});
test('concurrent conflicting callbacks accept at most one authoritative result', async () => {
  const f = await currentCheck();
  const r = await Promise.all([f.service.ingest(f.c, f.r4), f.service.ingest({ ...f.c, eventId: 'second', report: { ...f.report, reportId: 'second-report', outcome: 'FAIL' } }, f.r4)]);
  assert.equal(r.filter(x => x.status === 'ACCEPTED').length, 1); assert.equal((await f.db.getWorkflow(f.c.requestId))?.version, f.c.expectedVersion + 1);
  assert.equal((await f.db.listEvidence(f.c.requestId)).filter(e => e.kind === 'LOGIC_CHECKED').length, 1);
});
test('concurrent identical callback returns one acceptance and one duplicate', async () => {
  const f = await currentCheck(), r = await Promise.all([f.service.ingest(f.c, f.r4), f.service.ingest(f.c, f.r4)]);
  assert.equal(r.filter(x => x.status === 'ACCEPTED').length, 1); assert.equal(r.filter(x => x.status === 'DUPLICATE_EVENT').length, 1);
});
test('atomic callback failure leaves state report evidence and audit unchanged', async () => {
  let fail = false; const f = await currentCheck(checkerFixture({ testFaults: { beforeCommit() { if (fail) throw Error('fictional'); } } }));
  const s = await f.db.getWorkflow(f.c.requestId), audits = await f.db.listAudit(f.c.requestId), records = await f.db.listEvidence(f.c.requestId);
  fail = true; assert.equal((await f.service.ingest(f.c, f.r4)).status, 'STORAGE_FAILURE'); fail = false;
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), s); assert.deepEqual(await f.db.listAudit(f.c.requestId), audits);
  assert.deepEqual(await f.db.listEvidence(f.c.requestId), records); assert.equal(await f.db.getReceipt(f.c.requestId, f.c.eventId), null);
  assert.equal(await f.db.getCheckerReport(f.c.requestId, f.report.reportId), null); assert.equal((await f.service.ingest(f.c, f.r4)).status, 'ACCEPTED');
});
test('raw passed flag cannot bypass formal evidence for authenticated drafting proposal', async () => {
  const f = await awaitingCheck(); const r = await f.db.apply(command(f.s, { type: 'LOGIC_CHECKED', ...f.s.logic, reportId: 'unsolicited', passed: true }), 'checker');
  assert.equal(r.reason, 'CHECKER_RESULT_REQUIRED'); assert.equal((await f.db.getWorkflow(f.command.requestId))?.checks, null);
});
test('unsolicited callback without recorded invocation rejected', async () => {
  const f = await currentCheck(); const db = wrapCheckerStore(f.db, { getCheckerInvocation: async () => null });
  const service = new CheckerResultService({ ...f.checkerDeps, store: db });
  assert.equal((await service.ingest(f.c, f.r4)).reason, 'CHECKER_INVOCATION_REQUIRED');
});
test('trusted additional authorization may restrict but cannot elevate the wrong worker', async () => {
  const f = await currentCheck(); const service = new CheckerResultService({ ...f.checkerDeps, authorizeWorker: () => false });
  assert.equal((await service.ingest(f.c, f.r4)).reason, 'WORKER_NOT_AUTHORIZED');
});
test('passing report enters read-only queue and clinical command independently rechecks it', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4); const before = await f.db.listAudit(f.c.requestId);
  const q = await f.reviews.queue('CLINICAL', 'clinic'); if (q.status !== 'SUCCESS') throw Error(q.reason); assert.equal(q.items.length, 1);
  const ctx = await f.reviews.context(f.c.requestId, 'CLINICAL', 'clinic'); if (ctx.status !== 'SUCCESS') throw Error(ctx.reason);
  assert.equal(ctx.context.eligibility.eligible, true); assert.deepEqual(ctx.context.checkerReport, f.report);
  assert.equal(ctx.context.logicModel?.snapshotHash, f.c.logicHash); assert.deepEqual(await f.db.listAudit(f.c.requestId), before);
  assert.equal((await clinical(f)).status, 'SUCCESS'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.status, 'CLINICALLY_APPROVED');
});
test('checker service cannot clinically approve its own contributed result', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4); assert.equal((await clinical(f, f.checkerClinician)).status, 'REJECTED');
});
test('request revision removes passed proposal from active clinical queue', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4); await revise(f, 'request');
  const q = await f.reviews.queue('CLINICAL', 'clinic'); if (q.status !== 'SUCCESS') throw Error(q.reason); assert.deepEqual(q.items, []);
  assert.equal((await clinical(f)).status, 'REJECTED'); assert.ok(await f.db.getCheckerReport(f.c.requestId, f.report.reportId));
});
test('HTTP serialization preserves formal findings including blocked context', async () => {
  const f = await currentCheck(checkerFixture(), { findings: [warning] }); await f.service.ingest(f.c, f.r4);
  const api = createLocalApi({ store: f.db, approvals: new ApprovalService({ store: f.db, resolveActor: f.resolveActor }), reviews: f.reviews,
    authentication: { authenticate: () => ({ context: 'clinic' }), canAccessRequest: () => true } });
  try {
    const r = await api.inject({ method: 'GET', url: `/api/requests/${f.c.requestId}/review-context?category=CLINICAL` });
    assert.equal(r.statusCode, 200); assert.deepEqual(r.json().checkerReport, f.report); assert.equal(r.json().checker.invocationId, f.invocation.invocationId);
    assert.equal(r.json().eligibility.eligible, false); assert.equal(r.json().decisionReferences, null);
  } finally { await api.close(); }
});
test('unauthorized reviewer cannot inspect blocked report', async () => {
  const f = await currentCheck(checkerFixture(), { findings: [warning] }); await f.service.ingest(f.c, f.r4);
  assert.equal((await f.reviews.context(f.c.requestId, 'CLINICAL', 'outsider')).status, 'NOT_FOUND');
});
test('returned reports are detached and cannot mutate authoritative evidence', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4);
  const read = (await f.db.getCheckerReport(f.c.requestId, f.report.reportId))!;
  (read.report.references as string[]).push('mutated'); read.report.outcome = 'FAIL';
  assert.deepEqual((await f.db.getCheckerReport(f.c.requestId, f.report.reportId))?.report, f.report);
});
for (const extra of [{ roles: ['CHECKER'] }, { trusted: true }, { actorId: 'fictional-r4-checker-service' }]) test(`client authority field ${Object.keys(extra)[0]} rejected`, async () => {
  const f = await currentCheck(); assert.equal((await f.service.ingest({ ...f.c, ...extra }, f.r4)).reason, 'INVALID_COMMAND');
});
for (const patch of [{ reportId: '' }, { checkerVersion: '' }, { outcome: 'UNKNOWN' }, { findings: [warning, warning] },
  { findings: [{ ...warning, severity: 'UNKNOWN' }] }, { findings: [{ ...warning, blocking: 'false' }] }, { references: [NaN] }, { trusted: true }]) test(`malformed report ${JSON.stringify(patch)} rejected`, async () => {
  const f = await currentCheck(); const c = { ...f.c, report: { ...f.report, ...patch } } as unknown as CheckerResultCommand;
  assert.equal((await f.service.ingest(c, f.r4)).status, 'REJECTED'); assert.equal(parseCheckerReport(c.report), null);
});
test('INFO-only nonblocking PASS is allowed but is still not clinical approval', async () => {
  const f = await currentCheck(checkerFixture(), { findings: [{ ...warning, severity: 'INFO', blocking: false }] });
  assert.equal(checkerPassed(f.report), true); const r = await f.service.ingest(f.c, f.r4); assert.equal(r.result?.passed, true);
  assert.equal((await f.db.getWorkflow(f.c.requestId))?.clinicalApproval, null);
});
test('wrong worker cannot reserve event ID and block the authorized checker', async () => {
  const f = await currentCheck(); assert.equal((await f.service.ingest(f.c, f.other)).status, 'REJECTED');
  assert.equal((await f.service.ingest(f.c, f.r4)).status, 'ACCEPTED');
});
test('wrong-role attempt cannot reserve an event ID', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, 'clinic'); assert.equal((await f.service.ingest(f.c, f.r4)).status, 'ACCEPTED');
});
test('concurrent invocation authorization creates one stable authorization', async () => {
  const f = await awaitingCheck(), results = await Promise.all([f.service.authorize(f.command, 'backend'), f.service.authorize(f.command, 'backend')]);
  assert.equal(results.filter(r => r.status === 'AUTHORIZED').length, 1); assert.equal(results.filter(r => r.status === 'DUPLICATE_EVENT').length, 1);
  assert.deepEqual(results[0].invocation, results[1].invocation);
});
test('role revoked while callback is being read prevents commit', async () => {
  const f = await currentCheck(); let count = 0;
  const service = new CheckerResultService({ ...f.checkerDeps, resolveActor(p, id) {
    if (p === f.r4 && ++count > 1) return { id: 'fictional-r4-checker-service', roles: [] };
    return f.resolveActor(p);
  } });
  assert.equal((await service.ingest(f.c, f.r4)).reason, 'IDENTITY_CHANGED');
  assert.equal((await f.db.getWorkflow(f.c.requestId))?.status, 'WAITING_FOR_LOGIC_CHECKS');
});
test('access revoked before commit denies ingestion without advancing', async () => {
  const f = await currentCheck(); let n = 0;
  const service = new CheckerResultService({ ...f.checkerDeps, canAccessRequest: () => ++n < 2 });
  assert.equal((await service.ingest(f.c, f.r4)).reason, 'REQUEST_NOT_FOUND'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.checks, null);
});
test('unavailable snapshot storage cannot manufacture checker success', async () => {
  const f = await currentCheck(); const service = new CheckerResultService({ ...f.checkerDeps, store: wrapCheckerStore(f.db, { getSnapshot: async () => { throw Error('fictional outage'); } }) });
  assert.equal((await service.ingest(f.c, f.r4)).status, 'STORAGE_FAILURE'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.checks, null);
});
test('missing model snapshot blocks result ingestion', async () => {
  const f = await currentCheck(); const service = new CheckerResultService({ ...f.checkerDeps, store: wrapCheckerStore(f.db, { getSnapshot: async () => null }) });
  assert.equal((await service.ingest(f.c, f.r4)).reason, 'SNAPSHOT_REQUIRED'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.checks, null);
});
test('passing checks cannot start compilation before independent clinical approval', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4); const s = (await f.db.getWorkflow(f.c.requestId))!;
  const r = await f.db.apply(command(s, { type: 'START_COMPILATION', compilationId: 'fictional-compile' }), 'backend');
  assert.equal(r.outcome, 'REJECTED'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.compilationId, null);
});
test('passing checks cannot grant release approval', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4); const s = (await f.db.getWorkflow(f.c.requestId))!;
  const r = await f.db.apply(command(s, { type: 'RELEASE_DECISION', decision: 'APPROVE', evidence: {} }), 'release');
  assert.equal(r.outcome, 'REJECTED'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.releaseApproval, null);
});
test('missing formal metadata blocks approval even when passed flag is cached', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4);
  const store = wrapCheckerStore(f.db, { async listEvidence(id) { return (await f.db.listEvidence(id)).map(({ checkerResult: _removed, ...r }) => r); } });
  const s = (await f.db.getWorkflow(f.c.requestId))!;
  const result = await new ApprovalService({ store, resolveActor: f.resolveActor }).execute({ type: 'CLINICAL_DECISION', requestId: f.c.requestId,
    eventId: 'missing-formal-evidence', expectedVersion: s.version, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    ...s.logic!, checkerReportId: f.report.reportId, decision: 'APPROVE' }, 'clinic');
  assert.equal(result.reason, 'CHECKER_EVIDENCE_REQUIRED'); assert.equal((await f.db.getWorkflow(f.c.requestId))?.clinicalApproval, null);
});
test('accepted formal report retains exact source findings and references in receipt and audit', async () => {
  const f = await currentCheck(checkerFixture(), { findings: [warning], references: ['fictional-source-a', 'fictional-source-b'] });
  const r = await f.service.ingest(f.c, f.r4);
  assert.deepEqual((await f.db.getReceipt(f.c.requestId, f.c.eventId))?.checkerResult, r.result);
  assert.deepEqual((await f.db.listAudit(f.c.requestId)).at(-1)?.checkerResult, r.result);
});
test('raw flags cannot bypass formal checking after a LogicModel revision', async () => {
  const f = await currentCheck(); await f.service.ingest(f.c, f.r4); await revise(f, 'logic');
  const s = (await f.db.getWorkflow(f.c.requestId))!, r = await f.db.apply(command(s, { type: 'LOGIC_CHECKED', ...s.logic, reportId: 'fake-revised-checks', passed: true }), 'checker');
  assert.equal(r.reason, 'CHECKER_RESULT_REQUIRED');
});

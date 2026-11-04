import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftingCallbackService } from '../src/callbacks.ts';
import type { DraftingResultCommand } from '../src/callbacks.ts';
import { validationMatches } from '../src/callback-contracts.ts';
import type { PassedLogicValidation } from '../src/callback-contracts.ts';
import { canonicalizeJson, createSnapshot, provisionalSnapshotValidator } from '../src/snapshots.ts';
import { RequestService } from '../src/requests.ts';
import { ApprovalService } from '../src/approvals.ts';
import { content, next } from './helpers/approval-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { callbackFixture, draftingCallback, wrapResultStore, FictionalLogicValidation } from './helpers/callback-fixtures.ts';

test('verified current worker result commits an immutable proposal and job acceptance through LOGIC_PROPOSED', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'ACCEPTED', r.reason);
  const s = (await f.db.getWorkflow(f.c.requestId))!; assert.equal(s.status, 'WAITING_FOR_LOGIC_CHECKS'); assert.equal(s.version, f.c.expectedVersion + 1);
  const record = (await f.db.getDraftingResult(f.c.requestId, f.c.jobId))!, receipt = (await f.db.getReceipt(f.c.requestId, f.c.eventId))!;
  const snapshot = await f.db.getSnapshot({ kind: 'LOGIC_MODEL', requestId: f.c.requestId, revision: 1, requestPreview: record.requestPreview });
  assert.equal(snapshot!.snapshotHash, record.logic.logicHash); assert.equal(s.logic!.logicHash, snapshot!.snapshotHash); assert.equal(validationMatches(record.validation, snapshot!), true);
  assert.equal(canonicalizeJson(snapshot!.content), canonicalizeJson(f.c.logicModel)); assert.equal(record.sourceWorkflowVersion, f.job.sourceWorkflowVersion);
  assert.deepEqual(receipt.draftingResult, record); assert.deepEqual((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.draftingResult, record);
  assert.equal(record.validation.validatorId, 'fictional-r4-validator'); assert.equal(record.validation.validatorVersion, 'fixture-v1'); assert.ok(record.validation.resultId); assert.ok(record.validation.reportId);
  assert.equal(s.checks, null); assert.equal(s.clinicalApproval, null); assert.equal(s.releaseApproval, null); assert.ok(s.contributorIds.includes('fictional-r3-worker'));
});
test('identical accepted callback retry returns original outcome and does not call validation again', async () => {
  const f = await draftingCallback(), first = await f.callbacks.ingest(f.c, f.workerPrincipal), second = await f.callbacks.ingest(f.c, f.workerPrincipal);
  assert.equal(first.status, 'ACCEPTED'); assert.equal(second.status, 'DUPLICATE_EVENT'); assert.deepEqual(second.result, first.result); assert.equal(second.workflowVersion, first.workflowVersion); assert.equal(second.auditId, first.auditId);
  assert.notEqual(second.attemptAuditId, first.attemptAuditId); assert.equal(f.validation.calls, 1); assert.equal((await f.db.getWorkflow(f.c.requestId))!.version, 6);
});
test('a new service instance can replay the original accepted result without a live R4 adapter', async () => {
  const f = await draftingCallback(), first = await f.callbacks.ingest(f.c, f.workerPrincipal);
  const service = new DraftingCallbackService({ ...f.deps, validation: undefined }); const retry = await service.ingest(f.c, f.workerPrincipal);
  assert.equal(retry.status, 'DUPLICATE_EVENT'); assert.deepEqual(retry.result, first.result);
});
test('reordered JSON object keys remain the same callback', async () => {
  const f = await draftingCallback(); await f.callbacks.ingest(f.c, f.workerPrincipal);
  const c = { ...f.c, logicModel: Object.fromEntries(Object.entries(f.c.logicModel as object).reverse()) };
  assert.equal((await f.callbacks.ingest(c, f.workerPrincipal)).status, 'DUPLICATE_EVENT');
});
for (const change of [{ schemaVersion: '2.0' }, { sourceWorkflowVersion: 3 }, { snapshotHash: 'e'.repeat(64) }, { expectedVersion: 7 }, { revision: 2 }]) test(`accepted callback event reuse with changed ${Object.keys(change)[0]} conflicts`, async () => {
  const f = await draftingCallback(); await f.callbacks.ingest(f.c, f.workerPrincipal); const before = await f.db.getWorkflow(f.c.requestId);
  assert.equal((await f.callbacks.ingest({ ...f.c, ...change }, f.workerPrincipal)).reason, 'EVENT_ID_REUSED'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
});
test('changed LogicModel under accepted event ID cannot overwrite authoritative content', async () => {
  const f = await draftingCallback(), first = await f.callbacks.ingest(f.c, f.workerPrincipal);
  const r = await f.callbacks.ingest({ ...f.c, logicModel: { ...(f.c.logicModel as object), title: 'Different fictional interpretation' } }, f.workerPrincipal);
  assert.equal(r.reason, 'EVENT_ID_REUSED'); assert.deepEqual(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), first.result);
});
test('one logical drafting job cannot accept a second callback event as another proposal', async () => {
  const f = await draftingCallback(), first = await f.callbacks.ingest(f.c, f.workerPrincipal);
  const r = await f.callbacks.ingest({ ...f.c, eventId: 'other-result' }, f.workerPrincipal); assert.equal(r.status, 'STALE_VERSION'); assert.deepEqual(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), first.result);
});
test('concurrent conflicting results cannot create two authoritative models', async () => {
  const f = await draftingCallback(), results = await Promise.all(['a', 'b'].map(label => f.callbacks.ingest({ ...f.c, eventId: `result-${label}`, logicModel: { ...(f.c.logicModel as object), title: `Fictional proposal ${label}` } }, f.workerPrincipal)));
  assert.equal(results.filter(r => r.status === 'ACCEPTED').length, 1); assert.equal(results.filter(r => r.status === 'STALE_VERSION').length, 1);
  assert.equal((await f.db.listSnapshots(f.c.requestId)).filter(s => s.kind === 'LOGIC_MODEL').length, 1); assert.equal((await f.db.getWorkflow(f.c.requestId))!.version, 6);
});
test('concurrent identical callbacks return one accepted outcome and one duplicate', async () => {
  const f = await draftingCallback(), results = await Promise.all([f.callbacks.ingest(f.c, f.workerPrincipal), f.callbacks.ingest(f.c, f.workerPrincipal)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['ACCEPTED', 'DUPLICATE_EVENT']); assert.deepEqual(results[0].result, results[1].result); assert.equal(results[0].auditId, results[1].auditId);
});
test('accepted callback committed between receipt/state reads is replayed as duplicate', async () => {
  const f = await draftingCallback(); let receipts = 0;
  const store = wrapResultStore(f.db, { getReceipt: async (id, eventId) => { const r = await f.db.getReceipt(id, eventId); if (eventId === f.c.eventId && ++receipts === 1) assert.equal((await f.callbacks.ingest(f.c, f.workerPrincipal)).status, 'ACCEPTED'); return r; } });
  assert.equal((await new DraftingCallbackService({ ...f.deps, store }).ingest(f.c, f.workerPrincipal)).status, 'DUPLICATE_EVENT');
});
for (const changes of [{ expectedVersion: 4 }, { revision: 2 }, { snapshotHash: 'e'.repeat(64) }, { sourceWorkflowVersion: 3 }]) test(`current result rejects wrong ${Object.keys(changes)[0]}`, async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest({ ...f.c, ...changes }, f.workerPrincipal);
  assert.equal(r.status, 'STALE_VERSION'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
test('superseded preview cannot accept a late drafting result', async () => {
  const f = await draftingCallback(), requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  await requests.revise({ requestId: f.c.requestId, revision: f.c.revision, snapshotHash: f.c.snapshotHash, expectedVersion: f.c.expectedVersion, eventId: 'material-correction', content: content(2) }, 'po');
  const current = await f.db.getWorkflow(f.c.requestId), r = await f.callbacks.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'STALE_VERSION');
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), current); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('accepted retry after a later revision acknowledges history without restoring it', async () => {
  const f = await draftingCallback(), first = await f.callbacks.ingest(f.c, f.workerPrincipal), s = (await f.db.getWorkflow(f.c.requestId))!;
  const requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  await requests.revise({ requestId: f.c.requestId, revision: f.c.revision, snapshotHash: f.c.snapshotHash, expectedVersion: s.version, eventId: 'new-preview', content: content(2) }, 'po');
  const before = await f.db.getWorkflow(f.c.requestId), retry = await f.callbacks.ingest(f.c, f.workerPrincipal);
  assert.equal(retry.status, 'DUPLICATE_EVENT'); assert.equal(retry.workflowVersion, first.workflowVersion); assert.deepEqual(retry.result, first.result); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before);
});
test('unknown job does not fabricate a proposal or job result', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest({ ...f.c, jobId: 'unknown-job' }, f.workerPrincipal);
  assert.equal(r.reason, 'JOB_NOT_FOUND'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s); assert.equal((await f.db.listSnapshots(f.c.requestId)).length, 1);
});
test('an inaccessible request is rejected without private storage reads', async () => {
  const f = await draftingCallback(); let reads = 0;
  const service = new DraftingCallbackService({ ...f.deps, canAccessRequest: () => false, store: wrapResultStore(f.db, { getJob: async (id, jobId) => { reads++; return f.db.getJob(id, jobId); } }) });
  assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'REQUEST_NOT_FOUND'); assert.equal(reads, 0);
});
test('wrong request ID is hidden rather than exposing another request or job', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest({ ...f.c, requestId: 'another-private-request' }, f.workerPrincipal); assert.equal(r.reason, 'REQUEST_NOT_FOUND'); assert.equal(r.result, null);
});
for (const principal of [null, 'ai', 'worker', { roles: ['DRAFTER'], trusted: true }, { session: 'fictional-service-session' }]) test(`unverified context ${JSON.stringify(principal)} cannot authenticate`, async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest(f.c, principal); assert.equal(r.reason, 'UNAUTHORIZED'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s); assert.equal(f.validation.calls, 0);
});
test('a verified nonworker role is rejected and audited without accepting evidence', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest(f.c, f.wrongRolePrincipal); assert.equal(r.reason, 'WRONG_ROLE');
  assert.equal((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.outcome, 'REJECTED'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('a trusted job-scope policy can deny an otherwise verified DRAFTER', async () => {
  const f = await draftingCallback(), service = new DraftingCallbackService({ ...f.deps, authorizeWorker: () => false });
  assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'WORKER_NOT_AUTHORIZED'); assert.equal(f.validation.calls, 0);
});
test('policy cannot elevate a nonworker role', async () => {
  const f = await draftingCallback(), service = new DraftingCallbackService({ ...f.deps, authorizeWorker: () => true }); assert.equal((await service.ingest(f.c, f.wrongRolePrincipal)).reason, 'WRONG_ROLE');
});
test('a different worker cannot claim an accepted callback event as its retry', async () => {
  const f = await draftingCallback(); await f.callbacks.ingest(f.c, f.workerPrincipal); assert.equal((await f.callbacks.ingest(f.c, f.otherWorkerPrincipal)).reason, 'EVENT_ID_REUSED');
});
for (const logicModel of [{}, { schemaVersion: '1.0', title: 'Fictional incomplete model' }]) test('invalid LogicModel structure is rejected by injected schema boundary', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest({ ...f.c, logicModel }, f.workerPrincipal); assert.equal(r.reason, 'INVALID_LOGIC_MODEL'); assert.equal(f.validation.calls, 0); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
test('unsupported schema version is rejected without silently converting content', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest({ ...f.c, schemaVersion: '2.0' }, f.workerPrincipal); assert.equal(r.reason, 'INVALID_LOGIC_MODEL'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('missing R4 adapter blocks acceptance and clinical queue eligibility', async () => {
  const f = await draftingCallback(), service = new DraftingCallbackService({ ...f.deps, validation: undefined });
  const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'VALIDATION_UNAVAILABLE');
  assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null); assert.equal((await f.db.getWorkflow(f.c.requestId))!.checks, null);
  const queue = await f.reviews.queue('CLINICAL', 'clinic'); if (queue.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(queue.items, []);
});
for (const outcome of ['FAILED', 'UNAVAILABLE'] as const) test(`R4 ${outcome} cannot be treated as successful validation`, async () => {
  const f = await draftingCallback(), service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator, validateProposal: async () => ({ status: outcome }) } });
  const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, outcome === 'FAILED' ? 'REJECTED' : 'BLOCKED'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
test('R4 provider outage blocks without leaking internal details', async () => {
  const f = await draftingCallback(), service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator, validateProposal: async () => { throw Error('private service credential'); } } });
  const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'BLOCKED'); assert.equal(JSON.stringify(r).includes('private'), false);
});
for (const field of ['validatorId', 'validatorVersion', 'resultId', 'logic', 'requestPreview'] as const) test(`missing validation ${field} blocks rather than fabricating success`, async () => {
  const f = await draftingCallback(), validation = new FictionalLogicValidation(); const service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator,
    validateProposal: async snapshot => { const e = await validation.validateProposal(snapshot); const v = { ...e } as Record<string, unknown>; delete v[field]; return v as unknown as PassedLogicValidation; } } });
  const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'BLOCKED'); assert.equal(r.reason, 'INVALID_VALIDATION_EVIDENCE');
});
for (const field of ['requestId', 'schemaVersion', 'hashPolicyVersion', 'logic', 'requestPreview'] as const) test(`validation ${field} must bind to the computed snapshot`, async () => {
  const f = await draftingCallback(), validation = new FictionalLogicValidation(); const service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator,
    validateProposal: async snapshot => ({ ...await validation.validateProposal(snapshot), [field]: field === 'logic' ? { logicRevision: 1, logicHash: 'e'.repeat(64) } : field === 'requestPreview' ? { ...snapshot.requestPreview, revision: 2 } : 'wrong' }) as PassedLogicValidation } });
  assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'INVALID_VALIDATION_EVIDENCE');
});
test('failed atomic commit leaves no snapshot, result marker, receipt or partial audit', async () => {
  let fail = false; const f = await draftingCallback(callbackFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('fictional commit failure'); } } }));
  const before = { snapshots: await f.db.listSnapshots(f.c.requestId), audit: await f.db.listAudit(f.c.requestId), state: await f.db.getWorkflow(f.c.requestId) };
  fail = true; assert.equal((await f.callbacks.ingest(f.c, f.workerPrincipal)).status, 'STORAGE_FAILURE'); fail = false;
  assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null); assert.equal(await f.db.getReceipt(f.c.requestId, f.c.eventId), null);
  assert.deepEqual(await f.db.listSnapshots(f.c.requestId), before.snapshots); assert.deepEqual(await f.db.listAudit(f.c.requestId), before.audit); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before.state);
  assert.equal((await f.callbacks.ingest(f.c, f.workerPrincipal)).status, 'ACCEPTED');
});
test('validation receives an immutable snapshot and cannot silently mutate hashed content', async () => {
  const f = await draftingCallback(), validation = new FictionalLogicValidation();
  const service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator, validateProposal: async snapshot => {
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.content), true);
    assert.throws(() => { (snapshot.content as { title: string }).title = 'changed'; }); return validation.validateProposal(snapshot);
  } } }); assert.equal((await service.ingest(f.c, f.workerPrincipal)).status, 'ACCEPTED');
});
test('hash covers sources and all meaningful returned model content', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest(f.c, f.workerPrincipal);
  const changed = createSnapshot({ kind: 'LOGIC_MODEL', requestId: f.c.requestId, revision: 1, schemaVersion: '1.0', requestPreview: r.result!.requestPreview,
    content: { ...(f.c.logicModel as object), sources: [{ id: 'different-fictional-source' }] } }, provisionalSnapshotValidator);
  assert.notEqual(changed.snapshotHash, r.result!.logic.logicHash);
});
test('accepted schema/checker validation is not clinical approval or release permission', async () => {
  const f = await draftingCallback(), r = await f.callbacks.ingest(f.c, f.workerPrincipal), s = (await f.db.getWorkflow(f.c.requestId))!;
  const approvals = new ApprovalService({ store: f.db, resolveActor: resolveReviewActor });
  const clinical = await approvals.execute({ requestId: f.c.requestId, eventId: 'cannot-bypass-checks', expectedVersion: s.version,
    requestRevision: f.c.revision, requestSnapshotHash: f.c.snapshotHash, logicRevision: 1, logicHash: r.result!.logic.logicHash, checkerReportId: 'not-checked', type: 'CLINICAL_DECISION', decision: 'APPROVE' }, 'clinic');
  assert.equal(clinical.reason, 'CHECKER_EVIDENCE_REQUIRED');
  for (const type of ['START_COMPILATION', 'MAKE_DOWNLOAD_AVAILABLE'] as const) {
    const result = await f.db.apply({ requestId: f.c.requestId, attemptId: `bypass-${type}`, event: { ...(type === 'START_COMPILATION' ? { type, compilationId: 'fake' } : { type }),
      eventId: `bypass-${type}`, expectedVersion: s.version, request: { ...f.job.requestPreview } } }, 'backend'); assert.equal(result.outcome, 'REJECTED');
  }
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), s);
});
for (const extra of [{ actorId: 'worker' }, { roles: ['DRAFTER'] }, { trusted: true }, { validation: { status: 'PASSED' } }, { logicHash: 'a'.repeat(64) }, { clinicalApproval: true }]) test(`callback rejects worker-supplied ${Object.keys(extra)[0]}`, async () => {
  const f = await draftingCallback(); assert.equal((await f.callbacks.ingest({ ...f.c, ...extra }, f.workerPrincipal)).reason, 'INVALID_COMMAND');
});
test('non-JSON or malformed callback payloads fail closed', async () => {
  const f = await draftingCallback(); for (const input of [null, [], {}, { ...f.c, expectedVersion: 0 }, { ...f.c, logicModel: [] }, { ...f.c, logicModel: { invalid: NaN } }, { ...f.c, logicModel: { invalid: undefined } }]) assert.equal((await f.callbacks.ingest(input as DraftingResultCommand, f.workerPrincipal)).reason, 'INVALID_COMMAND');
});
test('trusted callback boundaries are mandatory', () => { assert.throws(() => new DraftingCallbackService({} as never)); });

test('failed validation retains available provider/report references without asserting a passed result', async () => {
  const f = await draftingCallback(), reference = { validatorId: 'fictional-checker', validatorVersion: 'fixture-2', resultId: 'fictional-failure-1', reportId: 'fictional-report-failed' };
  const service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator, validateProposal: async () => ({ status: 'FAILED', ...reference }) } });
  const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'REJECTED'); assert.deepEqual(r.validationReference, reference);
  assert.deepEqual((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.callbackValidation, reference);
  assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('optional report reference is not fabricated when R4 provides only required validation IDs', async () => {
  const f = await draftingCallback(), adapter = new FictionalLogicValidation();
  const service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator, validateProposal: async snapshot => {
    const v = await adapter.validateProposal(snapshot) as PassedLogicValidation; const { reportId: _report, ...rest } = v; return rest;
  } } }); const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'ACCEPTED'); assert.equal(r.result!.validation.reportId, undefined);
});
test('a request revised during R4 validation cannot accept the now-stale model', async () => {
  const f = await draftingCallback(), adapter = new FictionalLogicValidation(), requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  const service = new DraftingCallbackService({ ...f.deps, validation: { validateSnapshot: provisionalSnapshotValidator, validateProposal: async snapshot => {
    await requests.revise({ requestId: f.c.requestId, revision: f.c.revision, snapshotHash: f.c.snapshotHash, expectedVersion: f.c.expectedVersion, eventId: 'revision-during-validation', content: content(2) }, 'po');
    return adapter.validateProposal(snapshot);
  } } }); const r = await service.ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'STALE_VERSION'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
  assert.equal((await f.db.getWorkflow(f.c.requestId))!.status, 'WAITING_FOR_SCREENING'); assert.equal((await f.db.listSnapshots(f.c.requestId)).filter(s => s.kind === 'LOGIC_MODEL').length, 0);
});
test('wrong-job-type result cannot be authorized through a custom permission hook', async () => {
  const f = await draftingCallback(), store = wrapResultStore(f.db, { getJob: async (id, jobId) => { const job = await f.db.getJob(id, jobId); return job ? { ...job, jobType: 'COMPILE' } as never : null; } });
  const service = new DraftingCallbackService({ ...f.deps, store, authorizeWorker: () => true }); assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'WRONG_JOB_TYPE');
});
test('missing handoff receipt blocks an otherwise matching job callback', async () => {
  const f = await draftingCallback(), store = wrapResultStore(f.db, { getReceipt: async (id, event) => event === f.job.handoffEventId ? null : f.db.getReceipt(id, event) });
  assert.equal((await new DraftingCallbackService({ ...f.deps, store }).ingest(f.c, f.workerPrincipal)).reason, 'JOB_INTEGRITY');
});
test('read-storage failure cannot report a completed drafting job', async () => {
  const f = await draftingCallback(), store = wrapResultStore(f.db, { getJob: async () => { throw Error('private storage credentials'); } });
  const r = await new DraftingCallbackService({ ...f.deps, store }).ingest(f.c, f.workerPrincipal); assert.equal(r.status, 'STORAGE_FAILURE'); assert.equal(JSON.stringify(r).includes('private'), false);
});
test('a missing accepted-result record is an integrity failure rather than an idempotent success', async () => {
  const f = await draftingCallback(); await f.callbacks.ingest(f.c, f.workerPrincipal);
  const service = new DraftingCallbackService({ ...f.deps, store: wrapResultStore(f.db, { getDraftingResult: async () => null }) });
  assert.equal((await service.ingest(f.c, f.workerPrincipal)).status, 'STORAGE_FAILURE');
});
test('accepted result records and linked validation metadata cannot be overwritten by caller mutation', async () => {
  const f = await draftingCallback(); await f.callbacks.ingest(f.c, f.workerPrincipal);
  const copy = (await f.db.getDraftingResult(f.c.requestId, f.c.jobId))!; copy.validation.validatorId = 'changed-copy'; copy.logic.logicHash = 'f'.repeat(64);
  assert.equal((await f.db.getDraftingResult(f.c.requestId, f.c.jobId))!.validation.validatorId, 'fictional-r4-validator');
});
test('visibility revoked after validation prevents callback commitment', async () => {
  const f = await draftingCallback(); let checks = 0;
  const service = new DraftingCallbackService({ ...f.deps, canAccessRequest: () => ++checks === 1 }); assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'REQUEST_NOT_FOUND'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('worker role revocation during validation cannot be bypassed', async () => {
  const f = await draftingCallback(); let calls = 0;
  const service = new DraftingCallbackService({ ...f.deps, resolveActor: principal => ++calls === 1 ? f.deps.resolveActor(principal, f.c.requestId) : { id: 'fictional-r3-worker', roles: ['PO'] } });
  assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'IDENTITY_CHANGED'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('job-scope permission revocation prevents callback commitment', async () => {
  const f = await draftingCallback(); let checks = 0;
  const service = new DraftingCallbackService({ ...f.deps, authorizeWorker: () => ++checks === 1 }); assert.equal((await service.ingest(f.c, f.workerPrincipal)).reason, 'WORKER_NOT_AUTHORIZED');
});
test('worker role/identity is resolved again inside the final atomic write', async () => {
  let revoke = false; const f = await draftingCallback(callbackFixture({ resolveActor: p => typeof p === 'object' && p !== null && 'session' in p
    ? { id: 'fictional-r3-worker', roles: revoke ? ['PO'] : ['DRAFTER'] } : resolveReviewActor(p) }));
  revoke = true; const r = await f.callbacks.ingest(f.c, f.workerPrincipal); assert.equal(r.reason, 'WRONG_ROLE'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null);
});
test('late callback after an actual drafting failure cannot restart the job', async () => {
  const f = await draftingCallback(); await f.db.apply({ requestId: f.c.requestId, attemptId: 'draft-failed', event: { type: 'FAIL', eventId: 'draft-failed', expectedVersion: f.s.version,
    request: { ...f.job.requestPreview }, note: 'Fictional drafting cancelled.' } }, f.workerPrincipal);
  assert.equal((await f.callbacks.ingest(f.c, f.workerPrincipal)).status, 'STALE_VERSION'); assert.equal((await f.db.getWorkflow(f.c.requestId))!.status, 'FAILED');
});
test('an accepted proposal still requires separate checker evidence before appearing in the clinician queue', async () => {
  const f = await draftingCallback(); await f.callbacks.ingest(f.c, f.workerPrincipal);
  const queue = await f.reviews.queue('CLINICAL', 'clinic'); if (queue.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(queue.items, []);
});
test('application LOGIC_PROPOSED cannot advance if required callback job-result metadata is omitted', async () => {
  const f = await draftingCallback(), snapshot = createSnapshot({ kind: 'LOGIC_MODEL', requestId: f.c.requestId, revision: 1, schemaVersion: '1.0', requestPreview: { ...f.job.requestPreview }, content: f.c.logicModel }, provisionalSnapshotValidator);
  const r = await f.db.apply({ requestId: f.c.requestId, attemptId: 'missing-callback-record', commandFingerprint: 'a'.repeat(64), snapshots: [snapshot], event: {
    type: 'LOGIC_PROPOSED', eventId: 'missing-callback-record', expectedVersion: f.s.version, request: { ...f.job.requestPreview }, logicRevision: 1, logicHash: snapshot.snapshotHash,
  } }, f.workerPrincipal); assert.equal(r.reason, 'DRAFTING_RESULT_REQUIRED'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
test('storage rejects validation evidence bound to another model without partial snapshot writes', async () => {
  const f = await draftingCallback(), snapshot = createSnapshot({ kind: 'LOGIC_MODEL', requestId: f.c.requestId, revision: 1, schemaVersion: '1.0', requestPreview: { ...f.job.requestPreview }, content: f.c.logicModel }, provisionalSnapshotValidator);
  if (snapshot.kind !== 'LOGIC_MODEL') throw Error('fixture'); const validation = await f.validation.validateProposal(snapshot) as PassedLogicValidation;
  const r = await f.db.apply({ requestId: f.c.requestId, attemptId: 'wrong-validation', commandFingerprint: 'a'.repeat(64), snapshots: [snapshot], draftingResult: {
    requestId: f.c.requestId, jobId: f.c.jobId, eventId: f.c.eventId, requestPreview: { ...f.job.requestPreview }, sourceWorkflowVersion: f.job.sourceWorkflowVersion,
    jobWorkflowVersion: f.job.workflowVersion, acceptedWorkflowVersion: 6, handoffEventId: f.job.handoffEventId, logic: { logicRevision: 1, logicHash: snapshot.snapshotHash },
    validation: { ...validation, logic: { logicRevision: 1, logicHash: 'f'.repeat(64) } },
  }, event: { type: 'LOGIC_PROPOSED', eventId: f.c.eventId, expectedVersion: f.c.expectedVersion, request: { ...f.job.requestPreview }, logicRevision: 1, logicHash: snapshot.snapshotHash } }, f.workerPrincipal);
  assert.equal(r.reason, 'INVALID_VALIDATION_EVIDENCE'); assert.equal(await f.db.getDraftingResult(f.c.requestId, f.c.jobId), null); assert.equal((await f.db.listSnapshots(f.c.requestId)).length, 1);
});

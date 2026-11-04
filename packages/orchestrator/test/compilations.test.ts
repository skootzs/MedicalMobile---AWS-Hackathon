import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CompilationHandoffService } from '../src/compilations.ts';
import { compilationOutbox, createCompilationIntent } from '../src/compilation-contracts.ts';
import type { LogicModelReferenceProvider } from '../src/compilation-contracts.ts';
import { canonicalizeJson, logicModelIdentity, requestPreviewIdentity } from '../src/snapshots.ts';
import { FictionalChecker } from './helpers/checker-fixtures.ts';
import { compilationFixture, wrapCompilationStore } from './helpers/compilation-fixtures.ts';
import { command as eventCommand, model, preview, at, store as legacyStore } from './helpers/approval-fixtures.ts';

test('approved current model creates one approved compilation job and outbox atomically', async () => {
  const f = await compilationFixture(), r = await f.compile.start(f.command, 'backend');
  assert.equal(r.status, 'INTENT_RECORDED', r.reason); assert.ok(r.job);
  const job = r.job!, s = (await f.db.getWorkflow(f.command.requestId))!;
  assert.equal(s.status, 'COMPILING'); assert.equal(s.compilationId, job.jobId); assert.equal(s.version, f.command.expectedVersion + 1);
  assert.equal(job.jobType, 'COMPILE_LOGIC'); assert.equal(job.mode, 'approved'); assert.equal(job.status, 'PENDING');
  assert.equal(job.logicModelHash, f.current.logic!.logicHash); assert.equal(job.clinicalApprovalId, f.current.clinicalApproval!.eventId);
  assert.equal(job.checkerReportId, f.current.checks!.reportId); assert.equal(job.createdBy, 'fictional-backend'); assert.ok(!('baselineHash' in job));
  assert.deepEqual(await f.db.getCompilationJob(f.command.requestId, job.jobId), job);
  assert.deepEqual(await f.db.getCompilationOutbox(f.command.requestId, job.jobId), compilationOutbox(job));
  const receipt = await f.db.getReceipt(f.command.requestId, f.command.eventId); assert.equal(receipt?.compilationJobId, job.jobId);
  const audit = (await f.db.listAudit(f.command.requestId)).at(-1)!; assert.deepEqual(audit.compilationIntent, job); assert.deepEqual(audit.compilationOutbox, compilationOutbox(job));
  assert.equal(s.artifact, null); assert.equal(s.verification, null); assert.equal(s.releaseApproval, null);
});
for (const decision of [null, 'REJECT', 'RETURN'] as const) test(`clinical decision ${decision} cannot authorize compilation`, async () => {
  const f = await compilationFixture({}, decision), before = await f.db.getWorkflow(f.command.requestId);
  assert.equal((await f.compile.start(f.command, 'backend')).status, 'REJECTED'); assert.deepEqual(await f.db.getWorkflow(f.command.requestId), before);
  assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []); assert.equal(f.references.calls, 0);
  assert.equal((await f.db.listAudit(f.command.requestId)).at(-1)?.outcome, 'REJECTED');
});
for (const patch of [{ logicModelHash: 'a'.repeat(64) }, { logicModelRevision: 2 }, { revision: 2 }, { snapshotHash: 'a'.repeat(64) }, { expectedVersion: 1 }]) test(`stale expected ${Object.keys(patch)[0]} blocked`, async () => {
  const f = await compilationFixture(), before = await f.db.getWorkflow(f.command.requestId);
  assert.equal((await f.compile.start({ ...f.command, ...patch }, 'backend')).status, 'STALE_VERSION');
  assert.deepEqual(await f.db.getWorkflow(f.command.requestId), before); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('caller approval ID is only an expectation and must match authoritative record', async () => {
  const f = await compilationFixture(); assert.equal((await f.compile.start({ ...f.command, clinicalApprovalId: 'invented-approval' }, 'backend')).reason, 'CLINICAL_APPROVAL_MISMATCH');
});
for (const kind of ['request', 'logic'] as const) test(`${kind} revision supersedes approved handoff eligibility`, async () => {
  const f = await compilationFixture(), s = f.current, snapshot = kind === 'request' ? preview(2) : model(s, 2);
  const cmd = kind === 'request' ? eventCommand(s, { type: 'REVISE_REQUEST', brief: { ...snapshot.content, ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] })
    : eventCommand(s, { type: 'REVISE_LOGIC', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] });
  assert.equal((await f.db.apply(cmd, kind === 'request' ? 'po' : 'ai')).outcome, 'ACCEPTED');
  assert.equal((await f.compile.start(f.command, 'backend')).status, 'STALE_VERSION'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
for (const kind of ['checker', 'clinical'] as const) test(`missing ${kind} evidence blocks despite cached state flags`, async () => {
  const f = await compilationFixture();
  const db = wrapCompilationStore(f.db, { async listEvidence(id) { return (await f.db.listEvidence(id)).filter(r => r.kind !== (kind === 'checker' ? 'LOGIC_CHECKED' : 'CLINICAL_DECISION')); } });
  const result = await new CompilationHandoffService({ ...f.compileDeps, store: db }).start(f.command, 'backend');
  assert.equal(result.status, 'REJECTED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('missing formal checker metadata blocks compilation', async () => {
  const f = await compilationFixture(); const db = wrapCompilationStore(f.db, { async listEvidence(id) { return (await f.db.listEvidence(id)).map(({ checkerResult: _removed, ...r }) => r); } });
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, store: db }).start(f.command, 'backend')).reason, 'CHECKER_EVIDENCE_REQUIRED');
});
for (const field of ['clinical', 'checker'] as const) test(`missing ${field} accepted receipt blocks handoff`, async () => {
  const f = await compilationFixture(); const db = wrapCompilationStore(f.db, { getReceipt: async (id, event) => event === (field === 'clinical' ? f.command.clinicalApprovalId : f.c.eventId) ? null : f.db.getReceipt(id, event) });
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, store: db }).start(f.command, 'backend')).reason, 'APPROVAL_RECEIPT_REQUIRED');
});
test('legacy metadata-only checker fixture cannot authorize new compilation service', async () => {
  const db = legacyStore(), s = await at(db, 'CLINICALLY_APPROVED');
  const f = await compilationFixture(); const service = new CompilationHandoffService({ ...f.compileDeps, store: db });
  const r = await service.start({ ...f.command, expectedVersion: s.version, snapshotHash: s.brief.snapshotHash, logicModelHash: s.logic!.logicHash, clinicalApprovalId: s.clinicalApproval!.eventId }, 'backend');
  assert.equal(r.reason, 'FORMAL_CHECKER_EVIDENCE_REQUIRED');
});
for (const who of [null, 'clinic', 'po', 'compiler', 'release', { actorId: 'fictional-backend', roles: ['ORCHESTRATOR'], trusted: true }]) test(`unauthorized initiation ${JSON.stringify(who)} cannot create outbox`, async () => {
  const f = await compilationFixture(); assert.equal((await f.compile.start(f.command, who)).status, 'REJECTED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
for (const patch of [null, { uri: 'https://fictional.invalid/model.json' }, { uri: 's3://fictional-local-snapshots/snapshots/wrong.json' },
  { versionId: '' }, { verificationId: '' }, { byteSha256: 'a'.repeat(64) }, { byteLength: 1 }, { representation: 'raw-model' }, { hashPolicyVersion: 'unknown' },
  { logic: { logicRevision: 2, logicHash: 'a'.repeat(64) } }, { trusted: true }]) test(`unverified/mismatched snapshot reference ${JSON.stringify(patch)} rejected`, async () => {
  const f = await compilationFixture(); const provider: LogicModelReferenceProvider = { async getVerifiedReference(s) { return patch === null ? null : { ...await f.references.getVerifiedReference(s), ...patch } as never; } };
  const r = await new CompilationHandoffService({ ...f.compileDeps, snapshotReferences: provider }).start(f.command, 'backend');
  assert.equal(r.reason, 'VERIFIED_SNAPSHOT_REFERENCE_REQUIRED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('object bytes hash to the approved envelope hash, not raw content or self-hashing envelope', async () => {
  const f = await compilationFixture(), r = await f.compile.start(f.command, 'backend'); assert.ok(r.job);
  const bytes = f.references.objects.get(r.job!.logicModelUri)!;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), f.command.logicModelHash);
  const envelope = JSON.parse(bytes.toString()); assert.equal(envelope.kind, 'LOGIC_MODEL'); assert.equal(envelope.revision, f.command.logicModelRevision);
  assert.equal(envelope.requestPreview.revision, f.command.revision); assert.ok(!('snapshotHash' in envelope));
  assert.notEqual(createHash('sha256').update(canonicalizeJson(envelope.content)).digest('hex'), f.command.logicModelHash);
});
test('provider outage leaves workflow approved with no authoritative compilation job', async () => {
  const f = await compilationFixture(); const provider = { async getVerifiedReference() { throw Error('fictional S3 outage'); } };
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, snapshotReferences: provider }).start(f.command, 'backend')).status, 'STORAGE_FAILURE');
  assert.equal((await f.db.getWorkflow(f.command.requestId))?.status, 'CLINICALLY_APPROVED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('identical retry reuses job timestamp outbox and original receipt even when provider unavailable', async () => {
  const f = await compilationFixture(), a = await f.compile.start(f.command, 'backend');
  const service = new CompilationHandoffService({ ...f.compileDeps, snapshotReferences: { async getVerifiedReference() { throw Error('must not call'); } }, now: () => 'invalid' });
  const b = await service.start(f.command, 'backend'); assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.job, a.job); assert.equal(b.auditId, a.auditId);
  assert.equal((await f.db.listCompilationJobs(f.command.requestId)).length, 1); assert.deepEqual(await f.db.getCompilationOutbox(f.command.requestId, a.job!.jobId), compilationOutbox(a.job!));
});
test('event-ID reuse with changed command contents is rejected', async () => {
  const f = await compilationFixture(), a = await f.compile.start(f.command, 'backend');
  assert.equal((await f.compile.start({ ...f.command, clinicalApprovalId: 'another' }, 'backend')).reason, 'EVENT_ID_REUSED');
  assert.deepEqual((await f.db.listCompilationJobs(f.command.requestId)), [a.job]);
});
test('different event after handoff cannot create a second logical job', async () => {
  const f = await compilationFixture(); await f.compile.start(f.command, 'backend');
  assert.equal((await f.compile.start({ ...f.command, eventId: 'another' }, 'backend')).status, 'STALE_VERSION');
  assert.equal((await f.db.listCompilationJobs(f.command.requestId)).length, 1);
});
test('concurrent different commands cannot both consume one approved version', async () => {
  const f = await compilationFixture(), results = await Promise.all([f.compile.start(f.command, 'backend'), f.compile.start({ ...f.command, eventId: 'second' }, 'backend')]);
  assert.equal(results.filter(r => r.status === 'INTENT_RECORDED').length, 1); assert.equal((await f.db.listCompilationJobs(f.command.requestId)).length, 1);
  assert.equal((await f.db.getWorkflow(f.command.requestId))?.version, f.command.expectedVersion + 1);
});
test('concurrent identical commands yield one intent and one duplicate', async () => {
  const f = await compilationFixture(), r = await Promise.all([f.compile.start(f.command, 'backend'), f.compile.start(f.command, 'backend')]);
  assert.equal(r.filter(x => x.status === 'INTENT_RECORDED').length, 1); assert.equal(r.filter(x => x.status === 'DUPLICATE_EVENT').length, 1);
  assert.deepEqual(r[0].job, r[1].job);
});
test('failed transaction leaves no partial workflow job receipt audit or outbox', async () => {
  let fail = false; const f = await compilationFixture({ testFaults: { beforeCommit() { if (fail) throw Error('fictional'); } } });
  const before = await f.db.getWorkflow(f.command.requestId), audits = await f.db.listAudit(f.command.requestId); fail = true;
  const r = await f.compile.start(f.command, 'backend'); assert.equal(r.status, 'STORAGE_FAILURE'); fail = false;
  assert.deepEqual(await f.db.getWorkflow(f.command.requestId), before); assert.deepEqual(await f.db.listAudit(f.command.requestId), audits);
  assert.equal(await f.db.getReceipt(f.command.requestId, f.command.eventId), null); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
  // S3-first orphan may remain; this is harmless and does not authorize execution.
  assert.equal(f.references.objects.size, 1); assert.equal((await f.compile.start(f.command, 'backend')).status, 'INTENT_RECORDED');
});
test('raw start cannot advance formally checked workflow without intent and outbox', async () => {
  const f = await compilationFixture(); const r = await f.db.apply(eventCommand(f.current, { type: 'START_COMPILATION', compilationId: 'bare-compile' }), 'backend');
  assert.equal(r.reason, 'COMPILATION_INTENT_REQUIRED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('internal policy can restrict orchestrator but cannot elevate compiler role', async () => {
  const f = await compilationFixture(); assert.equal((await new CompilationHandoffService({ ...f.compileDeps, authorizeActor: () => false }).start(f.command, 'backend')).reason, 'WRONG_ROLE');
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, authorizeActor: () => true }).start(f.command, 'compiler')).status, 'REJECTED');
});
test('authority revoked during snapshot resolution blocks atomic handoff', async () => {
  const f = await compilationFixture(); let revoked = false;
  const service = new CompilationHandoffService({ ...f.compileDeps, snapshotReferences: { async getVerifiedReference(s) { const r = await f.references.getVerifiedReference(s); revoked = true; return r; } },
    resolveActor(p) { return revoked ? { id: 'fictional-backend', roles: [] } : f.resolveActor(p); } });
  assert.equal((await service.start(f.command, 'backend')).reason, 'IDENTITY_CHANGED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('revision during S3-first reference lookup is blocked by atomic version check', async () => {
  const f = await compilationFixture(); const service = new CompilationHandoffService({ ...f.compileDeps, snapshotReferences: { async getVerifiedReference(s) {
    const ref = await f.references.getVerifiedReference(s), snapshot = preview(2);
    assert.equal((await f.db.apply(eventCommand(f.current, { type: 'REVISE_REQUEST', brief: { ...snapshot.content, ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] }), 'po')).outcome, 'ACCEPTED');
    return ref;
  } } });
  assert.equal((await service.start(f.command, 'backend')).status, 'STALE_VERSION'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('job read models are detached and outbox reads never advance workflow', async () => {
  const f = await compilationFixture(), r = await f.compile.start(f.command, 'backend'), s = await f.db.getWorkflow(f.command.requestId), audits = await f.db.listAudit(f.command.requestId);
  const job = (await f.db.getCompilationJob(f.command.requestId, r.job!.jobId))!; job.logicModelUri = 'mutated';
  const outbox = (await f.db.getCompilationOutbox(f.command.requestId, r.job!.jobId))!; outbox.jobId = 'mutated';
  assert.deepEqual(await f.db.getCompilationJob(f.command.requestId, r.job!.jobId), r.job); assert.deepEqual(await f.db.getWorkflow(f.command.requestId), s);
  assert.deepEqual(await f.db.listAudit(f.command.requestId), audits);
});
for (const extra of [{ mode: 'preview' }, { roles: ['ORCHESTRATOR'] }, { actorId: 'fictional-backend' }, { trusted: true },
  { logicModelUri: 's3://invented/snapshots/model.json' }, { baselineHash: 'a'.repeat(64) }, { status: 'APPROVED' }]) test(`caller field ${Object.keys(extra)[0]} rejected`, async () => {
  const f = await compilationFixture(); assert.equal((await f.compile.start({ ...f.command, ...extra }, 'backend')).reason, 'INVALID_COMMAND');
});
test('invalid backend timestamp cannot create outbox', async () => {
  const f = await compilationFixture(); const service = new CompilationHandoffService({ ...f.compileDeps, now: () => 'not-a-date' });
  assert.equal((await service.start(f.command, 'backend')).status, 'REJECTED'); assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('compilation request does not imply verification or release approval', async () => {
  const f = await compilationFixture(); await f.compile.start(f.command, 'backend'); const s = (await f.db.getWorkflow(f.command.requestId))!;
  for (const payload of [{ type: 'START_VERIFICATION', verificationId: 'fictional-verification' }, { type: 'RELEASE_DECISION', decision: 'APPROVE', evidence: {} }]) {
    const r = await f.db.apply(eventCommand(s, payload), payload.type === 'START_VERIFICATION' ? 'backend' : 'release'); assert.equal(r.outcome, 'REJECTED');
  }
  assert.equal((await f.db.getWorkflow(f.command.requestId))?.status, 'COMPILING');
});
test('request revision 1 and approved LogicModel revision 2 remain distinct', async () => {
  const f = await compilationFixture(), snapshot = model(f.current, 2);
  if (snapshot.kind !== 'LOGIC_MODEL') throw Error('fixture');
  assert.equal((await f.db.apply(eventCommand(f.current, { type: 'REVISE_LOGIC', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] }), 'ai')).outcome, 'ACCEPTED');
  let s = (await f.db.getWorkflow(f.command.requestId))!;
  const identity = { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash };
  const authorized = await f.service.authorize({ ...identity, logicRevision: 2, logicHash: snapshot.snapshotHash, expectedVersion: s.version, eventId: 'authorize-second-model' }, 'backend');
  assert.equal(authorized.status, 'AUTHORIZED');
  const report = await new FictionalChecker({ reportId: 'second-report', resultId: 'second-result' }).check(authorized.invocation!, snapshot);
  assert.equal((await f.service.ingest({ ...identity, logicRevision: 2, logicHash: snapshot.snapshotHash, expectedVersion: s.version, eventId: 'check-second-model', invocationId: authorized.invocation!.invocationId, report }, f.r4)).status, 'ACCEPTED');
  s = (await f.db.getWorkflow(f.command.requestId))!;
  assert.equal((await f.approvals.execute({ type: 'CLINICAL_DECISION', requestId: s.brief.requestId, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    ...s.logic!, checkerReportId: s.checks!.reportId, eventId: 'second-clinical-approval', expectedVersion: s.version, decision: 'APPROVE' }, 'clinic')).status, 'SUCCESS');
  s = (await f.db.getWorkflow(f.command.requestId))!;
  const c = { ...f.command, logicModelRevision: 2, logicModelHash: snapshot.snapshotHash, expectedVersion: s.version, clinicalApprovalId: 'second-clinical-approval' };
  assert.equal((await f.compile.start({ ...c, revision: 2, logicModelRevision: 1 }, 'backend')).reason, 'STALE_REQUEST');
  const r = await f.compile.start(c, 'backend'); assert.equal(r.status, 'INTENT_RECORDED', r.reason);
  assert.equal(r.job!.revision, 1); assert.equal(r.job!.logicModelRevision, 2); assert.equal(r.job!.sourceWorkflowVersion, s.version);
});
test('historical duplicate after request revision never restores old compilation state', async () => {
  const f = await compilationFixture(), a = await f.compile.start(f.command, 'backend'), s = (await f.db.getWorkflow(f.command.requestId))!, snapshot = preview(2);
  assert.equal((await f.db.apply(eventCommand(s, { type: 'REVISE_REQUEST', brief: { ...snapshot.content, ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] }), 'po')).outcome, 'ACCEPTED');
  const before = await f.db.getWorkflow(f.command.requestId), b = await f.compile.start(f.command, 'backend');
  assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.job, a.job); assert.deepEqual(await f.db.getWorkflow(f.command.requestId), before);
});
test('snapshot upload does not authorize execution if atomic transaction fails', async () => {
  let fail = false; const f = await compilationFixture({ testFaults: { beforeCommit() { if (fail) throw Error('fictional failure'); } } });
  const snapshot = (await f.db.getSnapshot({ kind: 'LOGIC_MODEL', requestId: f.command.requestId, revision: f.command.logicModelRevision, requestPreview: {
    requestId: f.command.requestId, revision: f.command.revision, snapshotHash: f.command.snapshotHash } }))!;
  if (snapshot.kind !== 'LOGIC_MODEL') throw Error('fixture');
  const ref = await f.references.getVerifiedReference(snapshot);
  const expected = createCompilationIntent({ requestId: f.command.requestId, revision: f.command.revision, requestPreview: snapshot.requestPreview,
    logicModelRevision: snapshot.revision, logicModelHash: snapshot.snapshotHash, logicModelUri: ref.uri, snapshotReference: ref,
    clinicalApprovalId: f.command.clinicalApprovalId, checkerReportId: f.current.checks!.reportId, checkerInvocationId: f.current.checks!.invocationId!,
    handoffEventId: f.command.eventId, sourceWorkflowVersion: f.command.expectedVersion, createdBy: 'fictional-backend', createdAt: '2026-11-04T12:00:00.000Z' });
  fail = true; assert.equal((await f.compile.start(f.command, 'backend')).status, 'STORAGE_FAILURE'); fail = false;
  assert.equal(await f.db.getCompilationJob(f.command.requestId, expected.jobId), null);
  assert.equal(await f.db.getCompilationOutbox(f.command.requestId, expected.jobId), null);
});
test('atomic store rejects intent altered after application eligibility checks', async () => {
  const f = await compilationFixture(); const db = wrapCompilationStore(f.db, { async apply(c, p) {
    if (c.compilationIntent) c.compilationIntent.clinicalApprovalId = 'forged-approval';
    return f.db.apply(c, p);
  } });
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, store: db }).start(f.command, 'backend')).reason, 'INVALID_COMPILATION_INTENT');
  assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});
test('atomic store rejects preview-mode intent even from an orchestrator command', async () => {
  const f = await compilationFixture(); const db = wrapCompilationStore(f.db, { async apply(c, p) {
    if (c.compilationIntent) Object.assign(c.compilationIntent, { mode: 'preview' });
    return f.db.apply(c, p);
  } });
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, store: db }).start(f.command, 'backend')).reason, 'INVALID_COMPILATION_INTENT');
});
test('authoritative workflow and report store failures do not create intent', async () => {
  const f = await compilationFixture(); const db = wrapCompilationStore(f.db, { async listEvidence() { throw Error('fictional outage'); } });
  assert.equal((await new CompilationHandoffService({ ...f.compileDeps, store: db }).start(f.command, 'backend')).status, 'STORAGE_FAILURE');
  assert.deepEqual(await f.db.listCompilationJobs(f.command.requestId), []);
});

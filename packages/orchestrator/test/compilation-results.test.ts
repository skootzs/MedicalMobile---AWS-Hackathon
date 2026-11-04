import test from 'node:test';
import assert from 'node:assert/strict';
import { CompilationResultService } from '../src/compilation-results.ts';
import { parseCompilationExecution } from '../src/compilation-result-contracts.ts';
import { compilationResultFixture, sha } from './helpers/compilation-result-fixtures.ts';
import { command as eventCommand, preview, model } from './helpers/approval-fixtures.ts';
import { requestPreviewIdentity, logicModelIdentity } from '../src/snapshots.ts';
import type { WorkflowState } from '../src/workflow.ts';

async function unchanged(f: Awaited<ReturnType<typeof compilationResultFixture>>, before?: WorkflowState | null) {
  const current = await f.db.getWorkflow(f.job.requestId);
  if (before) assert.deepEqual(current, before);
  else { assert.equal(current?.status, 'COMPILING'); assert.equal(current?.version, f.job.workflowVersion); } assert.equal(await f.db.getCompilationResult(f.job.requestId, f.job.jobId), null);
}
function patchManifest(f: Awaited<ReturnType<typeof compilationResultFixture>>, change: (manifest: any) => void) {
  const r = f.source.current!, m = JSON.parse(f.artifacts.objects.get(r.manifestUri!)!.toString()); change(m);
  const bytes = Buffer.from(JSON.stringify(m)); f.artifacts.objects.set(r.manifestUri!, bytes); r.manifestHash = sha(bytes);
}

test('current verified successful result atomically records artifact and moves to WAITING_FOR_VERIFICATION', async () => {
  const f = await compilationResultFixture(), r = await f.results.ingest(f.commandResult, f.runner);
  assert.equal(r.status, 'ACCEPTED', r.reason); assert.equal(r.result?.outcome, 'COMPILED');
  const s = (await f.db.getWorkflow(f.job.requestId))!;
  assert.equal(s.status, 'WAITING_FOR_VERIFICATION'); assert.equal(s.version, f.job.workflowVersion + 1);
  assert.equal(s.artifact?.artifactHash, f.source.current!.artifactHash); assert.equal(s.compilerId, 'fictional-compiler');
  assert.equal(s.verification, null); assert.equal(s.releaseApproval, null);
  assert.deepEqual(await f.db.getCompilationResult(f.job.requestId, f.job.jobId), r.result);
  assert.deepEqual((await f.db.getReceipt(f.job.requestId, f.commandResult.eventId))?.compilationResult, r.result);
  assert.deepEqual((await f.db.listAudit(f.job.requestId)).at(-1)?.compilationResult, r.result);
  assert.deepEqual((await f.db.listEvidence(f.job.requestId)).find(e => e.kind === 'COMPILED')?.compilationResult, r.result);
});
test('R2 snapshot, R5 input, generated files and R7 archive hashes stay distinct', async () => {
  const f = await compilationResultFixture(), r = await f.results.ingest(f.commandResult, f.runner), a = r.result!.artifact!;
  assert.equal(new Set([r.result!.logicModelHash,a.inputHash,a.generatedFilesHash,a.packagedObject.sha256]).size, 4);
  assert.equal(a.stage, 'CHT_CONVERTED'); assert.equal(f.source.current!.chtConfStatus, 'PASSED');
  assert.equal(sha(f.artifacts.objects.get(a.packagedObject.uri)!), a.packagedObject.sha256);
});
for (const who of [null, 'compiler', { session: 'fictional-verified-r7', roles: ['COMPILER'], trusted: true }]) test(`unverified principal ${JSON.stringify(who)} rejected`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId);
  assert.equal((await f.results.ingest(f.commandResult, who)).reason, 'UNAUTHORIZED'); await unchanged(f, before);
});
test('verified wrong role cannot ingest runner results', async () => {
  const f = await compilationResultFixture(); assert.equal((await f.results.ingest(f.commandResult, f.wrong)).reason, 'WORKER_NOT_AUTHORIZED'); await unchanged(f);
});
test('required runner authorization restricts even a compiler principal', async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, authorizeRunner: () => false });
  assert.equal((await service.ingest(f.commandResult, f.runner)).reason, 'WORKER_NOT_AUTHORIZED'); await unchanged(f);
});
for (const patch of [{ jobId: 'unknown-job' }, { requestId: 'other-request' }, { expectedVersion: 1 }, { attempt: 2 }, { executionRecordVersion: 'old-record' }]) test(`incorrect callback ${Object.keys(patch)[0]} blocked`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId);
  const r = await f.results.ingest({ ...f.commandResult, ...patch }, f.runner); assert.ok(['REJECTED','STALE_VERSION'].includes(r.status)); await unchanged(f, before);
});
for (const patch of [{ clinicalApprovalId: 'wrong-approval' }, { logicModelHash: 'a'.repeat(64) }, { logicModelRevision: 2 }, { runnerActorId: 'other-runner' },
  { jobWorkflowVersion: 1 }, { jobId: 'other-job' }, { mode: 'preview' }, { jobType: 'DRAFT_LOGIC' }]) test(`authoritative record identity ${Object.keys(patch)[0]} mismatch cannot advance`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId); Object.assign(f.source.current!, patch);
  const r = await f.results.ingest(f.commandResult, f.runner); assert.notEqual(r.status, 'ACCEPTED'); await unchanged(f, before);
});
for (const kind of ['request','logic'] as const) test(`superseded ${kind} result rejected`, async () => {
  const f = await compilationResultFixture(), s = (await f.db.getWorkflow(f.job.requestId))!, snapshot = kind === 'request' ? preview(2) : model(s, 2);
  const cmd = kind === 'request' ? eventCommand(s, { type: 'REVISE_REQUEST', brief: { ...snapshot.content, ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] })
    : eventCommand(s, { type: 'REVISE_LOGIC', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] });
  assert.equal((await f.db.apply(cmd, kind === 'request' ? 'po' : 'ai')).outcome, 'ACCEPTED');
  const before = await f.db.getWorkflow(f.job.requestId); assert.equal((await f.results.ingest(f.commandResult, f.runner)).status, 'STALE_VERSION'); await unchanged(f, before);
});
for (const [uri, reason] of [['artifactUri','ARTIFACT_MISSING'],['manifestUri','MANIFEST_MISSING'],['reportUri','REPORT_MISSING']] as const) test(`${uri} object missing blocks successful status`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId); f.artifacts.objects.delete(f.source.current![uri]!);
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, reason); await unchanged(f, before);
});
for (const uri of ['artifactUri','manifestUri','reportUri'] as const) test(`wrong actual ${uri} bytes rejected`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId); f.artifacts.objects.set(f.source.current![uri]!, Buffer.from('fictional corruption'));
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'OBJECT_HASH_MISMATCH'); await unchanged(f, before);
});
for (const field of ['artifactHash','inputHash','manifestUri','manifestHash','reportUri','reportHash'] as const) test(`missing ${field} blocks ingestion`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId); f.source.current![field] = null;
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'ARTIFACT_EVIDENCE_REQUIRED'); await unchanged(f, before);
});
for (const field of ['snapshotHash','inputHash','schemaVersion','compilerVersion'] as const) test(`manifest ${field} mismatch rejected`, async () => {
  const f = await compilationResultFixture(), before = await f.db.getWorkflow(f.job.requestId); patchManifest(f, m => { m[field] = field.endsWith('Hash') ? 'a'.repeat(64) : 'unknown'; });
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'MANIFEST_INPUT_MISMATCH'); await unchanged(f, before);
});
test('individual generated file bytes are checked', async () => {
  const f = await compilationResultFixture(); f.artifacts.files.set('forms/app/training.xlsx', Buffer.from('wrong synthetic bytes'));
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'BUILD_FILE_HASH_MISMATCH'); await unchanged(f);
});
test('manifest missing file coverage rejected', async () => {
  const f = await compilationResultFixture(); patchManifest(f, m => m.files.pop());
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'FILE_COVERAGE_MISMATCH'); await unchanged(f);
});
test('R5 generated-files digest mismatch rejected separately from packaged-object digest', async () => {
  const f = await compilationResultFixture(); patchManifest(f, m => { m.artifactHash = 'a'.repeat(64); });
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'GENERATED_FILES_HASH_MISMATCH'); await unchanged(f);
});
for (const status of ['QUEUED','RUNNING'] as const) test(`${status} never means completed compilation`, async () => {
  const f = await compilationResultFixture(); Object.assign(f.source.current!, { status, finishedAt: null });
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'JOB_NOT_COMPLETED'); await unchanged(f);
});
test('absent verifier blocks rather than manufacturing success', async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, artifacts: undefined });
  assert.equal((await service.ingest(f.commandResult, f.runner)).status, 'BLOCKED'); await unchanged(f);
});
for (const mode of ['null','unavailable','throw'] as const) test(`verification ${mode} keeps workflow compiling`, async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, artifacts: { async verify() {
    if (mode === 'throw') throw Error('fictional unavailable'); return mode === 'null' ? null : { status: 'UNAVAILABLE', reason: 'fictional outage' };
  } } });
  assert.equal((await service.ingest(f.commandResult, f.runner)).reason, 'ARTIFACT_VERIFICATION_UNAVAILABLE'); await unchanged(f);
});
test('missing authoritative execution record blocks completion', async () => {
  const f = await compilationResultFixture(); f.source.current = null;
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'EXECUTION_EVIDENCE_UNAVAILABLE'); await unchanged(f);
});
for (const patch of [{ attempt: 0 }, { finishedAt: 'invalid' }, { startedAt: '2027-01-01T00:00:00.000Z' }, { compilerExitCode: 2 }, { chtConfStatus: 'FAILED' },
  { trusted: true }, { status: 'UNKNOWN' }, { toolVersions: {} }, { artifactHash: 'not-a-hash' }]) test(`malformed authoritative evidence ${JSON.stringify(patch)} rejected`, async () => {
  const f = await compilationResultFixture(); Object.assign(f.source.current!, patch);
  assert.equal(parseCompilationExecution(f.source.current), null); assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'MALFORMED_EXECUTION_EVIDENCE'); await unchanged(f);
});
for (const [kind, exit, status, cht] of [
  ['COMPILER_REJECTED',1,'FAILED','NOT_RUN'],['COMPILER_USAGE_OR_FILE_ERROR',2,'FAILED','NOT_RUN'],['CHT_CONVERSION_FAILED',0,'FAILED','FAILED'],
  ['CHT_VALIDATION_FAILED',0,'FAILED','FAILED'],['RUNNER_FAILED',null,'FAILED','NOT_RUN'],['TIMED_OUT',null,'TIMED_OUT','NOT_RUN'],['RETRIES_EXHAUSTED',null,'EXHAUSTED','NOT_RUN'],
] as const) test(`authoritative ${kind} preserved and applies existing FAIL, without retry policy`, async () => {
  const f = await compilationResultFixture(); Object.assign(f.source.current!, { status, compilerExitCode: exit, chtConfStatus: cht, failureKind: kind,
    errorCode: 'FICTIONAL_FAILURE', errorMessage: `Fictional ${kind} details.`, diagnostics: { errors: [{ code: 'FICTIONAL', message: 'Training-only failure details' }] } });
  const exact = structuredClone(f.source.current), r = await f.results.ingest(f.commandResult, f.runner);
  assert.equal(r.status, 'ACCEPTED', r.reason); assert.equal(r.reason, kind); assert.equal(r.result?.outcome, 'FAILED'); assert.deepEqual(r.result?.execution, exact);
  assert.equal(r.result?.artifact, null); assert.equal((await f.db.getWorkflow(f.job.requestId))?.status, 'FAILED'); assert.equal(f.artifacts.calls, 0);
  assert.deepEqual((await f.db.listAudit(f.job.requestId)).at(-1)?.compilationResult?.execution, exact);
  const retry = await f.results.ingest(f.commandResult, f.runner); assert.equal(retry.status, 'DUPLICATE_EVENT'); assert.deepEqual(retry.result, r.result);
});
test('identical successful retry returns original result without re-reading external evidence', async () => {
  const f = await compilationResultFixture(), a = await f.results.ingest(f.commandResult, f.runner), before = await f.db.getWorkflow(f.job.requestId);
  f.source.current = null; f.artifacts.objects.clear(); const b = await f.results.ingest(f.commandResult, f.runner);
  assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.result, a.result); assert.equal(b.auditId, a.auditId); assert.equal(f.artifacts.calls, 1);
  assert.deepEqual(await f.db.getWorkflow(f.job.requestId), before);
});
test('same event with changed attempt conflicts', async () => {
  const f = await compilationResultFixture(), a = await f.results.ingest(f.commandResult, f.runner);
  assert.equal((await f.results.ingest({ ...f.commandResult, attempt: 2 }, f.runner)).reason, 'EVENT_ID_REUSED');
  assert.deepEqual(await f.db.getCompilationResult(f.job.requestId, f.job.jobId), a.result);
});
test('different event cannot replace authoritative artifact', async () => {
  const f = await compilationResultFixture(), a = await f.results.ingest(f.commandResult, f.runner);
  assert.equal((await f.results.ingest({ ...f.commandResult, eventId: 'other-completion' }, f.runner)).status, 'STALE_VERSION');
  assert.deepEqual(await f.db.getCompilationResult(f.job.requestId, f.job.jobId), a.result);
});
test('concurrent identical callbacks yield one acceptance and one duplicate', async () => {
  const f = await compilationResultFixture(), r = await Promise.all([f.results.ingest(f.commandResult, f.runner), f.results.ingest(f.commandResult, f.runner)]);
  assert.equal(r.filter(x => x.status === 'ACCEPTED').length, 1); assert.equal(r.filter(x => x.status === 'DUPLICATE_EVENT').length, 1);
});
test('concurrent different callbacks cannot both advance', async () => {
  const f = await compilationResultFixture(), r = await Promise.all([f.results.ingest(f.commandResult, f.runner), f.results.ingest({ ...f.commandResult, eventId: 'second-result' }, f.runner)]);
  assert.equal(r.filter(x => x.status === 'ACCEPTED').length, 1); assert.equal((await f.db.getWorkflow(f.job.requestId))?.version, f.job.workflowVersion + 1);
});
test('obsolete attempt detected by atomic condition even after successful artifact verification', async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, artifacts: { async verify(input) {
    const r = await f.artifacts.verify(input); f.source.current!.attempt = 2; f.source.current!.recordVersion = 'fictional-execution-v2'; return r;
  } } });
  const r = await service.ingest(f.commandResult, f.runner); assert.equal(r.reason, 'STALE_JOB_ATTEMPT'); await unchanged(f);
});
test('failed atomic commit leaves no artifact result receipt audit or workflow advancement', async () => {
  let fail = false; const f = await compilationResultFixture({ testFaults: { beforeCommit() { if (fail) throw Error('fictional failure'); } } });
  const before = await f.db.getWorkflow(f.job.requestId), audits = await f.db.listAudit(f.job.requestId), records = await f.db.listEvidence(f.job.requestId); fail = true;
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).status, 'STORAGE_FAILURE'); fail = false;
  await unchanged(f, before); assert.deepEqual(await f.db.listAudit(f.job.requestId), audits); assert.deepEqual(await f.db.listEvidence(f.job.requestId), records);
  assert.equal(await f.db.getReceipt(f.job.requestId, f.commandResult.eventId), null); assert.equal((await f.results.ingest(f.commandResult, f.runner)).status, 'ACCEPTED');
});
test('raw COMPILED cannot bypass result/byte verification on a formal job', async () => {
  const f = await compilationResultFixture(), s = (await f.db.getWorkflow(f.job.requestId))!;
  const r = await f.db.apply(eventCommand(s, { type: 'COMPILED', artifact: { ...s.logic, compilationId: f.job.jobId, artifactHash: 'a'.repeat(64) } }), 'compiler');
  assert.equal(r.reason, 'COMPILATION_RESULT_REQUIRED'); await unchanged(f, s);
});
test('no execution conditional boundary means no accepted result', async () => {
  const f = await compilationResultFixture({ compilationExecutionIsCurrent: undefined });
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'EXECUTION_CONDITION_REQUIRED'); await unchanged(f);
});
test('accepted result references remain immutable to callers', async () => {
  const f = await compilationResultFixture(), r = await f.results.ingest(f.commandResult, f.runner), original = structuredClone(r.result);
  r.result!.artifact!.packagedObject.uri = 'mutated'; r.result!.execution.status = 'FAILED';
  assert.deepEqual(await f.db.getCompilationResult(f.job.requestId, f.job.jobId), original);
});
test('old accepted retry after revision never restores old model or artifact', async () => {
  const f = await compilationResultFixture(), a = await f.results.ingest(f.commandResult, f.runner), s = (await f.db.getWorkflow(f.job.requestId))!, snapshot = preview(2);
  assert.equal((await f.db.apply(eventCommand(s, { type: 'REVISE_REQUEST', brief: { ...snapshot.content, ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] }), 'po')).outcome, 'ACCEPTED');
  const before = await f.db.getWorkflow(f.job.requestId), b = await f.results.ingest(f.commandResult, f.runner);
  assert.equal(b.status, 'DUPLICATE_EVENT'); assert.deepEqual(b.result, a.result); assert.deepEqual(await f.db.getWorkflow(f.job.requestId), before);
});
for (const extra of [{ status: 'SUCCEEDED' }, { artifactHash: 'a'.repeat(64) }, { roles: ['COMPILER'] }, { trusted: true }, { actorId: 'fictional-compiler' }]) test(`notification field ${Object.keys(extra)[0]} cannot establish evidence`, async () => {
  const f = await compilationResultFixture(); assert.equal((await f.results.ingest({ ...f.commandResult, ...extra }, f.runner)).reason, 'INVALID_COMMAND');
});
test('compiled success does not bypass verification, release approval or download gates', async () => {
  const f = await compilationResultFixture(); await f.results.ingest(f.commandResult, f.runner); const s = (await f.db.getWorkflow(f.job.requestId))!;
  for (const [payload, who] of [[{ type: 'RELEASE_DECISION', decision: 'APPROVE', evidence: {} }, 'release'], [{ type: 'MAKE_DOWNLOAD_AVAILABLE' }, 'backend']] as const) {
    assert.equal((await f.db.apply(eventCommand(s, payload), who)).outcome, 'REJECTED');
  }
  assert.equal((await f.db.getWorkflow(f.job.requestId))?.status, 'WAITING_FOR_VERIFICATION');
});
test('runner identity revoked during artifact retrieval prevents commit', async () => {
  const f = await compilationResultFixture(); let revoked = false;
  const service = new CompilationResultService({ ...f.deps, resolveActor: (p,id) => revoked ? { id: 'fictional-compiler', roles: [] } : f.deps.resolveActor(p,id),
    artifacts: { async verify(input) { const r = await f.artifacts.verify(input); revoked = true; return r; } } });
  assert.equal((await service.ingest(f.commandResult, f.runner)).reason, 'IDENTITY_CHANGED'); await unchanged(f);
});
test('clinical approver cannot act as compiler service even with an elevated role claim', async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, store: { ...f.resultStore, apply: (c) => f.db.apply(c, 'clinic') },
    resolveActor: () => ({ id: 'fictional-clinician', roles: ['COMPILER'] }), authorizeRunner: () => true });
  assert.equal((await service.ingest(f.commandResult, f.runner)).reason, 'REVIEWER_NOT_INDEPENDENT'); await unchanged(f);
});
test('authoritative source outage cannot be converted into successful completion', async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, executions: { async getCurrent() { throw Error('fictional DynamoDB outage'); } } });
  assert.equal((await service.ingest(f.commandResult, f.runner)).status, 'STORAGE_FAILURE'); await unchanged(f);
});
for (const patch of [{ snapshotHash: 'a'.repeat(64) }, { inputHash: 'a'.repeat(64) }, { executionRecordVersion: 'other-record' }, { compilerVersion: 'other-version' },
  { packagedObject: { uri: 's3://fictional-compiled-objects/forged.bin', versionId: 'fake', sha256: 'a'.repeat(64), size: 123 } }]) test(`malformed verifier binding ${Object.keys(patch)[0]} cannot create authority`, async () => {
  const f = await compilationResultFixture(), service = new CompilationResultService({ ...f.deps, artifacts: { async verify(input) {
    const r = await f.artifacts.verify(input); if (r.status !== 'VERIFIED') return r;
    return { status: 'VERIFIED', artifact: { ...r.artifact, ...patch } };
  } } });
  assert.equal((await service.ingest(f.commandResult, f.runner)).reason, 'INVALID_ARTIFACT_EVIDENCE'); await unchanged(f);
});
test('terminal failure transaction rollback leaves failure result and workflow uncommitted', async () => {
  let fail = false; const f = await compilationResultFixture({ testFaults: { beforeCommit() { if (fail) throw Error('fictional'); } } });
  Object.assign(f.source.current!, { status: 'FAILED', failureKind: 'COMPILER_REJECTED', compilerExitCode: 1, errorCode: 'FICTIONAL_REJECTED', errorMessage: 'Fictional missing training field.' });
  const audits = await f.db.listAudit(f.job.requestId); fail = true;
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).status, 'STORAGE_FAILURE'); fail = false;
  await unchanged(f); assert.deepEqual(await f.db.listAudit(f.job.requestId), audits); assert.equal(await f.db.getReceipt(f.job.requestId, f.commandResult.eventId), null);
});
test('conflicting concurrent attempts cannot both publish different authoritative artifacts', async () => {
  const f = await compilationResultFixture(); let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const oldService = new CompilationResultService({ ...f.deps, artifacts: { async verify(input) { const r = await f.artifacts.verify(input); entered(); await hold; return r; } } });
  const old = oldService.ingest(f.commandResult, f.runner); await reached;
  const newPackage = f.artifacts.put('second-training-package.bin', Buffer.from('fictional alternate package bytes'));
  Object.assign(f.source.current!, { attempt: 2, recordVersion: 'fictional-execution-v2', artifactUri: newPackage.uri, artifactHash: newPackage.sha256, artifactVersionId: newPackage.versionId });
  const fresh = await f.results.ingest({ ...f.commandResult, eventId: 'second-attempt-result', attempt: 2, executionRecordVersion: 'fictional-execution-v2' }, f.runner);
  release(); const stale = await old;
  assert.equal(fresh.status, 'ACCEPTED'); assert.equal(stale.status, 'STALE_VERSION');
  assert.equal((await f.db.getCompilationResult(f.job.requestId, f.job.jobId))?.artifact?.packagedObject.sha256, newPackage.sha256);
});
test('hash-valid report contradicting compiler success is rejected by artifact boundary', async () => {
  const f = await compilationResultFixture(), r = f.source.current!, bytes = Buffer.from('{"fictional":true,"compilerExitCode":1}');
  f.artifacts.objects.set(r.reportUri!, bytes); r.reportHash = sha(bytes);
  assert.equal((await f.results.ingest(f.commandResult, f.runner)).reason, 'COMPILATION_REPORT_MISMATCH'); await unchanged(f);
});
test('blocked artifact attempt preserves exact authoritative execution reference in audit', async () => {
  const f = await compilationResultFixture(), original = structuredClone(f.source.current); f.artifacts.objects.delete(f.source.current!.artifactUri!);
  await f.results.ingest(f.commandResult, f.runner);
  const audit = (await f.db.listAudit(f.job.requestId)).at(-1)!;
  assert.equal(audit.outcome, 'REJECTED'); assert.equal(audit.compilationAttempt?.reason, 'ARTIFACT_MISSING'); assert.deepEqual(audit.compilationAttempt?.execution, original);
  assert.equal(audit.compilationResult, undefined); await unchanged(f);
});

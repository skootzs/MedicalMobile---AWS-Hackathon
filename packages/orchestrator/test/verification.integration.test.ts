/**
 * End-to-end VERIFY_BUILD handoff + R6 verification-result ingestion against
 * DynamoDB Local + the durable local object store.
 *
 * Reaches WAITING_FOR_VERIFICATION through the REAL R2 compilation path
 * (CompilationHandoffService + CompilationResultService, with a published R7
 * execution record), then exercises the new VerifyBuildHandoffService and
 * VerificationResultService.
 *
 * SIMULATED teammate outputs are clearly labelled: the R7 compile/verify JOB/META
 * records and the R6 VerificationReport are FICTIONAL fixtures, not real R5/R6/R7
 * runs. R2 still byte-verifies and schema-validates the fixture report exactly as
 * it would a real one.
 *
 * Gated on R2_DYNAMODB_LOCAL_ENDPOINT.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CompilationHandoffService } from '../src/compilations.ts';
import { CompilationResultService } from '../src/compilation-results.ts';
import { DurableLogicModelReferences } from '../src/storage/durable-objects.ts';
import { FictionalArtifacts } from './helpers/compilation-result-fixtures.ts';
import type { CompilationExecution } from '../src/compilation-result-contracts.ts';
import { ApprovalService } from '../src/approvals.ts';
import { VerifyBuildHandoffService } from '../src/verify-builds.ts';
import { VerificationResultService } from '../src/verification-results.ts';
import type { VerificationExecution } from '../src/verification-result-contracts.ts';
import { localClient, createLocalTable, durableLocalStore, LocalDiskObjects } from './helpers/dynamodb-local-fixtures.ts';
import { durableApi } from './helpers/dynamodb-api-fixture.ts';
import { content, next, command as eventCommand } from './helpers/approval-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { fictionalReport } from './helpers/verification-report-fixtures.ts';
import { validateVerifyBuildPayload } from '../src/r7-handoff-contract.ts';
import { toVerifyBuildPayload } from '../src/verify-build-contracts.ts';
import type { DynamoStoreOptions, DynamoOrchestratorStore } from '../src/storage/dynamodb.ts';
import type { WorkflowState, WorkflowStatus } from '../src/workflow.ts';
import type { ReportOverrides } from './helpers/verification-report-fixtures.ts';

const endpoint = process.env.R2_DYNAMODB_LOCAL_ENDPOINT;
const integration = { skip: !endpoint };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function createRequest(db: DynamoOrchestratorStore) {
  const h = durableApi(db);
  try {
    const r = await h.api.inject({ method: 'POST', url: '/api/requests', headers: { authorization: 'Bearer fictional-local-po' }, payload: { eventId: 'verify-create', expectedVersion: 0, content: content() } });
    assert.equal(r.statusCode, 201, r.body); return r.json().requestId as string;
  } finally { await h.api.close(); }
}
async function advance(db: DynamoOrchestratorStore, id: string, target: WorkflowStatus): Promise<WorkflowState> {
  let s = (await db.getWorkflow(id))!;
  while (s.status !== target) {
    if (s.status === 'WAITING_FOR_LOGIC_CHECKS') {
      const { CheckerResultService } = await import('../src/checkers.ts');
      const { FictionalChecker } = await import('./helpers/checker-fixtures.ts');
      const checker = new CheckerResultService({ store: db, resolveActor: resolveReviewActor, canAccessRequest: () => true,
        checker: { checkerActorId: 'fictional-checker', checkerId: 'fictional-r4-checker', checkerVersion: 'fixture-v1' } });
      const c = { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, ...s.logic!, expectedVersion: s.version, eventId: `fx-auth-${s.version}` };
      const a = await checker.authorize(c, 'backend'); assert.equal(a.status, 'AUTHORIZED', a.reason);
      const snap = await db.getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: s.logic!.logicRevision, requestPreview: { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash } });
      if (snap?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
      const report = await new FictionalChecker().check(a.invocation!, snap);
      assert.equal((await checker.ingest({ ...c, eventId: `fx-chk-${s.version}`, invocationId: a.invocation!.invocationId, report }, 'checker')).status, 'ACCEPTED');
    } else {
      const step = next(s); assert.equal((await db.apply(step.cmd, step.who)).outcome, 'ACCEPTED');
    }
    s = (await db.getWorkflow(id))!;
  }
  return s;
}

/** Drive the REAL compile path to WAITING_FOR_VERIFICATION, returning the accepted artifact. */
async function toVerification(t: TestContext) {
  const table = `r2-local-test-${randomUUID()}`, directory = await mkdtemp(join(tmpdir(), 'r2-verify-'));
  const client = localClient(endpoint!);
  await createLocalTable(client.client, table);
  t.after(async () => { client.client.destroy(); await rm(directory, { recursive: true, force: true }); });
  const newStore = (options: Partial<DynamoStoreOptions> = {}) => durableLocalStore(client.document, table, directory, options);
  const objects = new LocalDiskObjects(directory);
  const db = newStore();
  const id = await createRequest(db);
  const approvedState = await advance(db, id, 'WAITING_FOR_CLINICAL_APPROVAL');
  assert.equal((await new ApprovalService({ store: db, resolveActor: resolveReviewActor }).execute({
    type: 'CLINICAL_DECISION', requestId: id, eventId: 'fx-clinical', expectedVersion: approvedState.version,
    requestRevision: approvedState.brief.revision, requestSnapshotHash: approvedState.brief.snapshotHash,
    ...approvedState.logic!, checkerReportId: approvedState.checks!.reportId, decision: 'APPROVE',
  }, 'clinic')).status, 'SUCCESS');
  const approved = (await db.getWorkflow(id))!;
  // Compile handoff.
  const started = await new CompilationHandoffService({ store: db, resolveActor: resolveReviewActor, canAccessRequest: () => true,
    snapshotReferences: new DurableLogicModelReferences(objects) }).start({
      requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash,
      logicModelRevision: approved.logic!.logicRevision, logicModelHash: approved.logic!.logicHash,
      expectedVersion: approved.version, eventId: 'fx-compile-start', clinicalApprovalId: approved.clinicalApproval!.eventId }, 'backend');
  assert.equal(started.status, 'INTENT_RECORDED', started.reason);
  const job = started.job!;
  const model = await db.getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: job.logicModelRevision, requestPreview: job.requestPreview });
  if (model?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
  // Simulated R7 compile JOB/META execution record.
  const artifacts = new FictionalArtifacts(), execution = artifacts.make(job, model);
  const publishCompile = (v: CompilationExecution) => client.document.send(new UpdateCommand({ TableName: table, Key: { pk: `JOB#${job.jobId}`, sk: 'META' },
    UpdateExpression: 'SET executionRecordVersion = :v, attempt = :a, #s = :s, execution = :e', ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':v': v.recordVersion, ':a': v.attempt, ':s': v.status, ':e': v } }));
  await publishCompile(execution);
  const executionCondition: DynamoStoreOptions['executionCondition'] = e => ({ TableName: table, Key: { pk: `JOB#${e.jobId}`, sk: 'META' },
    ConditionExpression: 'executionRecordVersion = :v AND attempt = :a AND #s = :s', ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':v': e.recordVersion, ':a': e.attempt, ':s': e.status } });
  const compileSource = { async getCurrent(requestId: string, jobId: string) { const r = await client.document.send(new GetCommand({ TableName: table, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true })); return r.Item?.requestId === requestId ? r.Item.execution as CompilationExecution : null; } };
  const compileResult = await new CompilationResultService({ store: newStore({ executionCondition }), executions: compileSource, artifacts,
    resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: a => a.id === 'fictional-compiler' }).ingest({
      requestId: id, jobId: job.jobId, eventId: 'fx-compiled', expectedVersion: job.workflowVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'compiler');
  assert.equal(compileResult.status, 'ACCEPTED', compileResult.reason);
  const waiting = (await db.getWorkflow(id))!;
  assert.equal(waiting.status, 'WAITING_FOR_VERIFICATION');
  const acceptedArtifact = (await db.getCompilationResult(id, job.jobId))!.artifact!;
  return { table, directory, client, newStore, objects, db, id, state: waiting, compileJobId: job.jobId, artifact: acceptedArtifact };
}

/** Put a FICTIONAL R6 report object in the object store + a simulated R7 verify JOB/META. */
async function stageVerificationRun(f: Awaited<ReturnType<typeof toVerification>>, verifyJobId: string, workflowVersion: number, runnerId: string, over: ReportOverrides) {
  const report = fictionalReport({
    compileArtifactHash: f.artifact.generatedFilesHash,
    references: { logicModelHash: f.state.logic!.logicHash, clinicalApprovalId: f.state.clinicalApproval!.eventId, compilationJobId: f.compileJobId, packageHash: f.artifact.packagedObject.sha256 },
    ...over,
  });
  const bytes = Buffer.from(JSON.stringify(report));
  const reportHash = sha(bytes);
  const ref = await f.objects.putIfAbsent(`previews/reports/${reportHash}.json`, bytes);
  const execution: VerificationExecution = {
    requestId: f.id, jobId: verifyJobId, jobType: 'VERIFY_BUILD', attempt: 1, recordVersion: 'fictional-verify-exec-v1', runnerActorId: runnerId,
    status: 'SUCCEEDED', requestPreview: { requestId: f.id, revision: f.state.brief.revision, snapshotHash: f.state.brief.snapshotHash },
    logicModelRevision: f.state.logic!.logicRevision, logicModelHash: f.state.logic!.logicHash, clinicalApprovalId: f.state.clinicalApproval!.eventId,
    compileJobId: f.compileJobId, jobWorkflowVersion: workflowVersion,
    reportUri: ref.uri, reportHash, reportVersionId: ref.versionId,
    verificationPassed: report.passed as boolean, coverageComplete: report.coverageComplete as boolean, reportVersion: report.schemaVersion as string,
    startedAt: '2026-11-04T13:00:00.000Z', finishedAt: '2026-11-04T13:05:00.000Z', errorCode: null, errorMessage: null,
  };
  await f.client.document.send(new UpdateCommand({ TableName: f.table, Key: { pk: `JOB#${verifyJobId}`, sk: 'META' },
    UpdateExpression: 'SET executionRecordVersion = :v, attempt = :a, #s = :s, execution = :e', ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':v': execution.recordVersion, ':a': execution.attempt, ':s': execution.status, ':e': execution } }));
  return { execution, reportHash };
}

function verificationCondition(table: string): DynamoStoreOptions['verificationCondition'] {
  return e => ({ TableName: table, Key: { pk: `JOB#${e.jobId}`, sk: 'META' },
    ConditionExpression: 'executionRecordVersion = :v AND attempt = :a AND #s = :s', ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':v': e.recordVersion, ':a': e.attempt, ':s': e.status } });
}
function verifySource(f: Awaited<ReturnType<typeof toVerification>>) {
  return { async getCurrent(requestId: string, jobId: string) { const r = await f.client.document.send(new GetCommand({ TableName: f.table, Key: { pk: `JOB#${jobId}`, sk: 'META' }, ConsistentRead: true })); return r.Item?.requestId === requestId ? r.Item.execution as VerificationExecution : null; } };
}
async function startVerifyBuild(f: Awaited<ReturnType<typeof toVerification>>) {
  const handoff = new VerifyBuildHandoffService({ store: f.db, resolveActor: resolveReviewActor, canAccessRequest: () => true });
  const r = await handoff.start({ requestId: f.id, revision: f.state.brief.revision, snapshotHash: f.state.brief.snapshotHash,
    logicModelRevision: f.state.logic!.logicRevision, logicModelHash: f.state.logic!.logicHash, expectedVersion: f.state.version,
    eventId: 'fx-verify-start', compileJobId: f.compileJobId }, 'backend');
  return r;
}

test('VERIFY: handoff records a VERIFY_BUILD job + outbox bound to the exact artifact', integration, async t => {
  const f = await toVerification(t);
  const r = await startVerifyBuild(f);
  assert.equal(r.status, 'INTENT_RECORDED', r.reason);
  const job = r.job!;
  assert.equal(job.compileJobId, f.compileJobId);
  assert.equal(job.packageHash, f.artifact.packagedObject.sha256);
  assert.equal(job.manifestHash, f.artifact.manifest.sha256);
  assert.equal(job.compileArtifactHash, f.artifact.generatedFilesHash);
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'VERIFYING');
  // checkReportHash is a real digest (not compileArtifactHash) and snapshotUri is
  // the real immutable S3 object URI threaded from the compile job's reference.
  assert.match(job.checkReportHash, /^[a-f0-9]{64}$/);
  assert.notEqual(job.checkReportHash, job.compileArtifactHash);
  assert.match(job.snapshotUri, new RegExp(`/snapshots/${job.logicModelHash}\\.json$`));
  assert.ok(!job.snapshotUri.startsWith('s3://r2/')); // the fabricated URI is gone
  // The JOB/META + OUTBOX were committed atomically.
  const outbox = await f.db.getVerifyBuildOutbox(f.id, job.jobId);
  assert.equal(outbox?.jobType, 'VERIFY_BUILD');

  // R7 compatibility, read from the AUTHORITATIVE DynamoDB items:
  // (B) JOB/META must start in PENDING with the GSI1 attributes.
  const meta = (await f.client.document.send(new GetCommand({ TableName: f.table, Key: { pk: `JOB#${job.jobId}`, sk: 'META' }, ConsistentRead: true }))).Item!;
  assert.equal(meta.status, 'PENDING');
  assert.equal(meta.gsi1pk, `REQ#${f.id}`);
  assert.ok(typeof meta.gsi1sk === 'string' && meta.gsi1sk.startsWith('JOB#'));
  // (A) OUTBOX.payload must be EXACTLY the validated R7 wire payload R7 forwards.
  const outboxItem = (await f.client.document.send(new GetCommand({ TableName: f.table, Key: { pk: `JOB#${job.jobId}`, sk: 'OUTBOX' }, ConsistentRead: true }))).Item!;
  assert.equal(outboxItem.status, 'PENDING');
  assert.ok(outboxItem.payload, 'OUTBOX carries a payload');
  assert.equal(validateVerifyBuildPayload(outboxItem.payload).ok, true, JSON.stringify(outboxItem.payload));
  assert.deepEqual(outboxItem.payload, toVerifyBuildPayload(job));
  // The payload must NOT leak R2's internal intent fields (e.g. idempotencyKey, status).
  assert.ok(!('idempotencyKey' in (outboxItem.payload as Record<string, unknown>)));
  assert.ok(!('status' in (outboxItem.payload as Record<string, unknown>)));
});

test('VERIFY: a passing report advances to WAITING_FOR_RELEASE_APPROVAL', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-verifier', { passed: true, coverageComplete: true });
  const ingest = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }),
    executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: a => a.id === 'fictional-verifier' });
  const r = await ingest.ingest({ requestId: f.id, jobId: verifyJobId, eventId: 'fx-verified', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'verifier');
  assert.equal(r.status, 'ACCEPTED', r.reason);
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'WAITING_FOR_RELEASE_APPROVAL');
});

test('VERIFY: a failing report blocks release (workflow goes to FAILED, not release)', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-verifier', { passed: false, coverageComplete: false });
  const ingest = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }),
    executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: a => a.id === 'fictional-verifier' });
  const r = await ingest.ingest({ requestId: f.id, jobId: verifyJobId, eventId: 'fx-failed', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'verifier');
  assert.equal(r.status, 'ACCEPTED', r.reason);
  assert.equal(r.result?.outcome, 'FAILED');
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'FAILED');
});

test('VERIFY: a tampered report (bytes != reportHash) fails closed, no advance', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-verifier', { passed: true });
  // Corrupt the stored report object so its bytes no longer match reportHash.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(f.directory, 'previews', 'reports', `${execution.reportHash}.json`), 'tampered');
  const ingest = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }),
    executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: a => a.id === 'fictional-verifier' });
  const r = await ingest.ingest({ requestId: f.id, jobId: verifyJobId, eventId: 'fx-tampered', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'verifier');
  assert.notEqual(r.status, 'ACCEPTED');
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'VERIFYING'); // unchanged
});

test('VERIFY: a report whose references mismatch R2 identities is rejected', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-verifier', { passed: true, references: { packageHash: 'f'.repeat(64) } });
  const ingest = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }),
    executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: a => a.id === 'fictional-verifier' });
  const r = await ingest.ingest({ requestId: f.id, jobId: verifyJobId, eventId: 'fx-refmismatch', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'verifier');
  assert.notEqual(r.status, 'ACCEPTED');
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'VERIFYING');
});

test('VERIFY: a non-independent verifier (same as clinician) is rejected', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  // Runner actor id == the clinical approver's actor id (fictional-clinician).
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-clinician', { passed: true });
  const ingest = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }),
    executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: () => true });
  const r = await ingest.ingest({ requestId: f.id, jobId: verifyJobId, eventId: 'fx-nonindep', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'clinic');
  assert.notEqual(r.status, 'ACCEPTED');
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'VERIFYING');
});

test('VERIFY: duplicate verification result ingestion is idempotent', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-verifier', { passed: true });
  const cmd = { requestId: f.id, jobId: verifyJobId, eventId: 'fx-dup', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion };
  const a = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }), executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: x => x.id === 'fictional-verifier' });
  const b = new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }), executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: x => x.id === 'fictional-verifier' });
  const results = await Promise.all([a.ingest(cmd, 'verifier'), b.ingest(cmd, 'verifier')]);
  const accepted = results.filter(r => r.status === 'ACCEPTED').length, dup = results.filter(r => r.status === 'DUPLICATE_EVENT').length;
  assert.equal(accepted + dup, 2, JSON.stringify(results));
  assert.ok(accepted >= 1);
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'WAITING_FOR_RELEASE_APPROVAL');
});

test('VERIFY: full gate to RELEASE_APPROVED with an independent release approver', integration, async t => {
  const f = await toVerification(t);
  const started = await startVerifyBuild(f); assert.equal(started.status, 'INTENT_RECORDED');
  const verifyJobId = started.job!.jobId, wfVersion = started.job!.workflowVersion;
  const { execution } = await stageVerificationRun(f, verifyJobId, wfVersion, 'fictional-verifier', { passed: true });
  assert.equal((await new VerificationResultService({ store: f.newStore({ verificationCondition: verificationCondition(f.table) }), executions: verifySource(f), objects: f.objects, resolveActor: resolveReviewActor, canAccessRequest: () => true, authorizeRunner: x => x.id === 'fictional-verifier' })
    .ingest({ requestId: f.id, jobId: verifyJobId, eventId: 'fx-verified', expectedVersion: wfVersion, attempt: execution.attempt, executionRecordVersion: execution.recordVersion }, 'verifier')).status, 'ACCEPTED');
  const pending = (await f.db.getWorkflow(f.id))!;
  assert.equal(pending.status, 'WAITING_FOR_RELEASE_APPROVAL');
  const release = {
    type: 'RELEASE_DECISION' as const, requestId: f.id, eventId: 'fx-release', expectedVersion: pending.version,
    requestRevision: pending.brief.revision, requestSnapshotHash: pending.brief.snapshotHash, ...pending.logic!,
    decision: 'APPROVE' as const, clinicalApprovalEventId: pending.clinicalApproval!.eventId,
    compilationId: pending.artifact!.compilationId, artifactHash: pending.artifact!.artifactHash,
    verificationId: pending.verification!.verificationId, verificationReportHash: pending.verification!.reportHash,
  };
  const approvals = new ApprovalService({ store: f.newStore(), resolveActor: resolveReviewActor });
  // Before release, the artifact endpoint must NOT expose anything (404).
  const beforeApi = durableApi(f.newStore());
  try {
    const early = await beforeApi.api.inject({ method: 'GET', url: `/api/requests/${f.id}/artifact`, headers: { authorization: 'Bearer fictional-local-po' } });
    assert.equal(early.statusCode, 404, early.body);
  } finally { await beforeApi.api.close(); }
  // The clinician cannot also be the release approver.
  assert.equal((await approvals.execute({ ...release, eventId: 'fx-clin-release' }, 'clinicRelease')).status, 'REJECTED');
  assert.equal((await approvals.execute(release, 'release')).status, 'SUCCESS');
  assert.equal((await f.db.getWorkflow(f.id))?.status, 'RELEASE_APPROVED');
  // After release, R1 can retrieve the approved artifact reference.
  const api = durableApi(f.newStore());
  try {
    const got = await api.api.inject({ method: 'GET', url: `/api/requests/${f.id}/artifact`, headers: { authorization: 'Bearer fictional-local-po' } });
    assert.equal(got.statusCode, 200, got.body);
    const body = got.json();
    assert.equal(body.released, true);
    assert.equal(body.artifactHash, pending.artifact!.artifactHash);
    assert.equal(body.reportHash, pending.verification!.reportHash);
    assert.equal(body.verificationId, pending.verification!.verificationId);
    assert.equal(body.package.sha256, pending.artifact!.artifactHash);
    assert.ok(body.package.uri.startsWith('s3://'));
  } finally { await api.api.close(); }
});

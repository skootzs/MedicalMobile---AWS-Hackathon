/**
 * ONE complete ASSEMBLED R2 integration scenario.
 *
 * Drives the REAL production composition root — `bootstrap()` — not separately
 * constructed services. R1-facing calls go through the bootstrapped Fastify app;
 * the R5/R6 machine-to-machine boundaries go through the bootstrapped
 * `services` (handoffs + the JobCompletionReconciler that reads R7's
 * authoritative JOB/META). Backed by DynamoDB Local + a durable local object store.
 *
 * SIMULATED teammate processing (clearly fictional, never claimed as real):
 *   - Screening/routing/drafting (R3) and checker results (R4) via TEST FIXTURES.
 *   - R7 compile/verify JOB/META written FLAT exactly as R7's runner writes it,
 *     so R2's real flat-META adapter + reconciler are exercised.
 *   - R5 artifact verification via the existing FictionalArtifacts verifier.
 *   - R6 VerificationReport: a FICTIONAL but schema-valid 2.3.0 document that R2
 *     byte-verifies, schema-validates and cross-checks. No evidence is faked in R2.
 *
 * Gated on R2_DYNAMODB_LOCAL_ENDPOINT.
 */
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { bootstrap } from '../src/bootstrap.ts';
import type { BootstrapOptions, WorkerPolicies } from '../src/bootstrap.ts';
import { createDemoIdentity, demoHeaders } from '../src/demo-identity.ts';
import { resolveCognitoActor } from '../src/cognito-auth.ts';
import { LocalObjectStore } from '../src/storage/local-objects.ts';
import { localClient, createLocalTable } from './helpers/dynamodb-local-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { next } from './helpers/approval-fixtures.ts';
import { CheckerResultService } from '../src/checkers.ts';
import { FictionalChecker } from './helpers/checker-fixtures.ts';
import { FictionalArtifacts } from './helpers/compilation-result-fixtures.ts';
import { fictionalReport } from './helpers/verification-report-fixtures.ts';
import type { CompilationExecution } from '../src/compilation-result-contracts.ts';
import type { Actor, WorkflowState } from '../src/workflow.ts';
import { DynamoOrchestratorStore } from '../src/storage/dynamodb.ts';
import { r7Layout } from '../src/storage/r7-layout.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';

const endpoint = process.env.R2_DYNAMODB_LOCAL_ENDPOINT;
const integration = { skip: !endpoint };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const WORKERS: Record<string, Actor> = {
  'svc-compiler': { id: 'fictional-compiler', roles: ['COMPILER'] },
  'svc-verifier': { id: 'fictional-verifier', roles: ['VERIFIER'] },
};
const resolveServiceActor = (p: unknown): Actor | null => (typeof p === 'string' ? WORKERS[p] ?? null : null);
const mixedResolver = (p: unknown): Actor | null => resolveCognitoActor(p) ?? (typeof p === 'string' ? resolveReviewActor(p) : null);
// The ORCHESTRATOR-driven handoffs use the human (Cognito) resolver, so they
// take the SAME verified-claims context the HTTP path produces, not a token.
const developerClaims = Object.freeze({ sub: 'demo-developer', groups: ['developer'] });

async function setup(t: TestContext) {
  const table = `r2-local-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'r2-assembled-'));
  const client = localClient(endpoint!);
  await createLocalTable(client.client, table);
  t.after(async () => { client.client.destroy(); await rm(directory, { recursive: true, force: true }); });
  const objects = new LocalObjectStore(directory);
  const artifacts = new FictionalArtifacts();
  const workers: WorkerPolicies = {
    resolveServiceActor,
    canServiceAccessRequest: (p, id) => resolveServiceActor(p) !== null && typeof id === 'string' && id.startsWith('req-'),
    authorizeCompilationRunner: (actor) => actor.id === 'fictional-compiler',
    authorizeVerificationRunner: (actor) => actor.id === 'fictional-verifier',
    compilationArtifacts: artifacts,
  };
  const options: BootstrapOptions = {
    config: Object.freeze({ mode: 'local', dynamoEndpoint: endpoint!, ddbTable: table, objectDirectory: directory, host: '127.0.0.1', port: 0 }),
    identity: createDemoIdentity({ requestPrefix: 'req-' }), workers, documentClient: client.document, objects,
  };
  const makeServer = () => bootstrap(options);
  const makeStore = () => new DynamoOrchestratorStore({ client: client.document, tableName: table, objects: new LocalObjectStore(directory),
    layout: r7Layout, resolveActor: mixedResolver, validateSnapshot: provisionalSnapshotValidator });
  return { table, directory, client, objects, artifacts, makeServer, makeStore };
}

/** FICTIONAL R3/R4: advance to WAITING_FOR_CLINICAL_APPROVAL via fixtures. */
async function advanceToClinical(store: DynamoOrchestratorStore, id: string, ownerSub: string): Promise<WorkflowState> {
  let s = (await store.getWorkflow(id))!;
  while (s.status !== 'WAITING_FOR_CLINICAL_APPROVAL') {
    if (s.status === 'WAITING_FOR_LOGIC_CHECKS') {
      const checker = new CheckerResultService({ store, resolveActor: mixedResolver, canAccessRequest: () => true,
        checker: { checkerActorId: 'fictional-checker', checkerId: 'fictional-r4-checker', checkerVersion: 'fixture-v1' } });
      const c = { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, ...s.logic!, expectedVersion: s.version, eventId: `fx-auth-${s.version}` };
      const a = await checker.authorize(c, 'backend'); assert.equal(a.status, 'AUTHORIZED', a.reason);
      const snap = await store.getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: s.logic!.logicRevision, requestPreview: { requestId: id, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash } });
      if (snap?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
      const report = await new FictionalChecker().check(a.invocation!, snap);
      assert.equal((await checker.ingest({ ...c, eventId: `fx-chk-${s.version}`, invocationId: a.invocation!.invocationId, report }, 'checker')).status, 'ACCEPTED');
    } else {
      const step = next(s);
      const who = step.who === 'po' ? { sub: ownerSub, groups: ['po'] } : step.who;
      assert.equal((await store.apply(step.cmd, who)).outcome, 'ACCEPTED', step.cmd.event.type);
    }
    s = (await store.getWorkflow(id))!;
  }
  return s;
}

/** Write R7's flat compile JobResult onto JOB/META from a FictionalArtifacts execution. */
async function publishCompileMeta(f: Awaited<ReturnType<typeof setup>>, e: CompilationExecution, attempt = e.attempt) {
  await f.client.document.send(new UpdateCommand({ TableName: f.table, Key: { pk: `JOB#${e.jobId}`, sk: 'META' },
    UpdateExpression: 'SET requestId=:r, #s=:s, attempt=:a, leaseOwner=:o, startedAt=:st, finishedAt=:fi, logicModelHash=:lh, packageHash=:ph, packageUri=:pu, packageVersionId=:pv, manifestHash=:mh, manifestUri=:mu, manifestVersionId=:mv, compileReportUri=:ru, compileReportHash=:rh, compileReportVersionId=:rv, compileArtifactHash=:ca, inputHash=:ih, toolVersions=:tv, errorCode=:ec, errorMessage=:em',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':r': e.requestId, ':s': 'SUCCEEDED', ':a': attempt, ':o': e.runnerActorId, ':st': e.startedAt, ':fi': e.finishedAt,
      ':lh': e.logicModelHash, ':ph': e.artifactHash, ':pu': e.artifactUri, ':pv': e.artifactVersionId, ':mh': e.manifestHash, ':mu': e.manifestUri, ':mv': e.manifestVersionId,
      ':ru': e.reportUri, ':rh': e.reportHash, ':rv': e.reportVersionId, ':ca': e.compileArtifactHash, ':ih': e.inputHash, ':tv': e.toolVersions, ':ec': null, ':em': null } }));
}
/** Write R7's flat verify JobResult onto JOB/META. */
async function publishVerifyMeta(f: Awaited<ReturnType<typeof setup>>, jobId: string, requestId: string, report: { reportUri: string; reportHash: string; reportVersionId: string; passed: boolean; coverageComplete: boolean; reportVersion: string }, attempt = 1) {
  await f.client.document.send(new UpdateCommand({ TableName: f.table, Key: { pk: `JOB#${jobId}`, sk: 'META' },
    UpdateExpression: 'SET requestId=:r, #s=:s, attempt=:a, leaseOwner=:o, startedAt=:st, finishedAt=:fi, reportUri=:ru, reportHash=:rh, reportVersionId=:rv, verificationPassed=:vp, coverageComplete=:cc, reportVersion=:ver, errorCode=:ec, errorMessage=:em',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':r': requestId, ':s': 'SUCCEEDED', ':a': attempt, ':o': 'fictional-verifier', ':st': '2026-11-04T13:00:00.000Z', ':fi': '2026-11-04T13:05:00.000Z',
      ':ru': report.reportUri, ':rh': report.reportHash, ':rv': report.reportVersionId, ':vp': report.passed, ':cc': report.coverageComplete, ':ver': report.reportVersion, ':ec': null, ':em': null } }));
}

test('ASSEMBLED: request -> release through bootstrap(), with restart recovery and fail-closed checks', integration, async (t) => {
  const f = await setup(t);

  // 1. PO creates a request over the bootstrapped HTTP API.
  let id: string;
  { const s = f.makeServer(); try {
    const res = await s.app.inject({ method: 'POST', url: '/api/requests', headers: demoHeaders('demo-po'),
      payload: { eventId: 'assembled-create', expectedVersion: 0, content: { title: 'Fictional assembled E2E', objective: 'Full chain.', targetPopulation: 'Fictional', requirements: [{ condition: 'x', action: 'y' }] } } });
    assert.equal(res.statusCode, 201, res.body); id = res.json().requestId as string; assert.ok(id.startsWith('req-'));
  } finally { await s.close(); } }

  // 2+3. Advance through screening/drafting/checker (fictional R3/R4); clinician approves over HTTP.
  const pending = await advanceToClinical(f.makeStore(), id, 'demo-po');
  { const s = f.makeServer(); try {
    const body = { eventId: 'assembled-clinical', expectedVersion: pending.version, requestRevision: pending.brief.revision, requestSnapshotHash: pending.brief.snapshotHash,
      logicRevision: pending.logic!.logicRevision, logicHash: pending.logic!.logicHash, checkerReportId: pending.checks!.reportId, decision: 'APPROVE' as const };
    // Fail-closed: author self-approval blocked.
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, headers: demoHeaders('demo-po-clinician'), payload: { ...body, eventId: 'assembled-self' } })).statusCode, 403);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, headers: demoHeaders('demo-clinician'), payload: body })).statusCode, 200);
  } finally { await s.close(); } }
  const approved = (await f.makeStore().getWorkflow(id))!;
  assert.equal(approved.status, 'CLINICALLY_APPROVED');

  // 4. R2 creates an authorized COMPILE_LOGIC job via the bootstrapped handoff.
  let compileJobId: string;
  { const s = f.makeServer(); try {
    const r = await s.services.compilationHandoff.start({ requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash,
      logicModelRevision: approved.logic!.logicRevision, logicModelHash: approved.logic!.logicHash, expectedVersion: approved.version,
      eventId: 'assembled-compile-start', clinicalApprovalId: approved.clinicalApproval!.eventId }, developerClaims);
    assert.equal(r.status, 'INTENT_RECORDED', r.reason); compileJobId = r.job!.jobId;
  } finally { await s.close(); } }

  // 5. A fictional R7 compile result (flat JOB/META) is ingested via the reconciler.
  const model = await f.makeStore().getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: approved.logic!.logicRevision, requestPreview: { requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash } });
  if (model?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
  const compileJob = (await f.makeStore().getCompilationJob(id, compileJobId))!;
  const compileExec = f.artifacts.make(compileJob, model); // writes fictional R5 objects into f.objects
  await publishCompileMeta(f, compileExec);
  { const s = f.makeServer(); try {
    const r = await s.services.reconciler.reconcile({ requestId: id, jobId: compileJobId, jobType: 'COMPILE_LOGIC', attempt: compileExec.attempt }, 'svc-compiler');
    assert.equal(r.status, 'RECONCILED', r.reason);
    assert.equal(r.jobType, 'COMPILE_LOGIC');
  } finally { await s.close(); } }
  const waitingVerify = (await f.makeStore().getWorkflow(id))!;
  assert.equal(waitingVerify.status, 'WAITING_FOR_VERIFICATION');

  // 6. R2 creates an authorized VERIFY_BUILD job via the bootstrapped handoff.
  let verifyJobId: string;
  { const s = f.makeServer(); try {
    const r = await s.services.verifyBuildHandoff.start({ requestId: id, revision: waitingVerify.brief.revision, snapshotHash: waitingVerify.brief.snapshotHash,
      logicModelRevision: waitingVerify.logic!.logicRevision, logicModelHash: waitingVerify.logic!.logicHash, expectedVersion: waitingVerify.version,
      eventId: 'assembled-verify-start', compileJobId }, developerClaims);
    assert.equal(r.status, 'INTENT_RECORDED', r.reason); verifyJobId = r.job!.jobId;
  } finally { await s.close(); } }
  const verifyJob = (await f.makeStore().getVerifyBuildJob(id, verifyJobId))!;

  // 7. A schema-valid fictional R6 report is byte-stored + flat META published; reconciled.
  const reportDoc = fictionalReport({ passed: true, coverageComplete: true, compileArtifactHash: verifyJob.compileArtifactHash,
    references: { logicModelHash: verifyJob.logicModelHash, clinicalApprovalId: verifyJob.clinicalApprovalId, compilationJobId: verifyJob.compileJobId, packageHash: verifyJob.packageHash } });
  const reportBytes = Buffer.from(JSON.stringify(reportDoc));
  const reportRef = await f.objects.putIfAbsent(`previews/reports/${sha(reportBytes)}.json`, reportBytes);
  await publishVerifyMeta(f, verifyJobId, id, { reportUri: reportRef.uri, reportHash: reportRef.sha256, reportVersionId: reportRef.versionId, passed: true, coverageComplete: true, reportVersion: '2.3.0' });
  { const s = f.makeServer(); try {
    const r = await s.services.reconciler.reconcile({ requestId: id, jobId: verifyJobId, jobType: 'VERIFY_BUILD', attempt: 1 }, 'svc-verifier');
    assert.equal(r.status, 'RECONCILED', r.reason);
    assert.equal(r.jobType, 'VERIFY_BUILD');
  } finally { await s.close(); } }
  const pendingRelease = (await f.makeStore().getWorkflow(id))!;
  assert.equal(pendingRelease.status, 'WAITING_FOR_RELEASE_APPROVAL');

  // 8. Independent release approval over HTTP.
  { const s = f.makeServer(); try {
    const body = { eventId: 'assembled-release', expectedVersion: pendingRelease.version, requestRevision: pendingRelease.brief.revision, requestSnapshotHash: pendingRelease.brief.snapshotHash,
      logicRevision: pendingRelease.logic!.logicRevision, logicHash: pendingRelease.logic!.logicHash, decision: 'APPROVE' as const,
      clinicalApprovalEventId: pendingRelease.clinicalApproval!.eventId, compilationId: pendingRelease.artifact!.compilationId, artifactHash: pendingRelease.artifact!.artifactHash,
      verificationId: pendingRelease.verification!.verificationId, verificationReportHash: pendingRelease.verification!.reportHash };
    // Fail-closed: clinician cannot also be the release approver.
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/requests/${id}/release-decisions`, headers: demoHeaders('demo-po-clinician'), payload: { ...body, eventId: 'assembled-release-self' } })).statusCode, 403);
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/requests/${id}/release-decisions`, headers: demoHeaders('demo-release'), payload: body })).statusCode, 200);
  } finally { await s.close(); } }

  // 9. R1-facing API returns the exact approved artifact reference.
  { const s = f.makeServer(); try {
    const got = await s.app.inject({ method: 'GET', url: `/api/requests/${id}/artifact`, headers: demoHeaders('demo-po') });
    assert.equal(got.statusCode, 200, got.body);
    const body = got.json();
    assert.equal(body.released, true);
    assert.equal(body.artifactHash, pendingRelease.artifact!.artifactHash);
    assert.equal(body.reportHash, pendingRelease.verification!.reportHash);
    assert.equal(body.verificationId, pendingRelease.verification!.verificationId);
    assert.equal(body.package.sha256, pendingRelease.artifact!.artifactHash);
  } finally { await s.close(); } }

  // 10. Restart: a brand-new bootstrap() preserves workflow, jobs, approvals, audit.
  { const s = f.makeServer(); try {
    const status = await s.app.inject({ method: 'GET', url: `/api/requests/${id}/status`, headers: demoHeaders('demo-po') });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().status, 'RELEASE_APPROVED');
    const artifact = await s.app.inject({ method: 'GET', url: `/api/requests/${id}/artifact`, headers: demoHeaders('demo-po') });
    assert.equal(artifact.statusCode, 200, artifact.body);
  } finally { await s.close(); } }
  const recovered = f.makeStore();
  assert.equal((await recovered.getWorkflow(id))?.status, 'RELEASE_APPROVED');
  assert.ok((await recovered.listAudit(id)).length > 0);
  assert.ok((await recovered.getCompilationResult(id, compileJobId)) !== null);
  assert.ok((await recovered.getVerificationResult(id, verifyJobId)) !== null);
});

test('ASSEMBLED fail-closed: forged worker identity, stale attempt, and incomplete coverage are rejected', integration, async (t) => {
  const f = await setup(t);
  // Build up to a verify job the same way.
  let id: string;
  { const s = f.makeServer(); try {
    const res = await s.app.inject({ method: 'POST', url: '/api/requests', headers: demoHeaders('demo-po'),
      payload: { eventId: 'fc-create', expectedVersion: 0, content: { title: 'Fictional fail-closed', objective: 'Guards.', targetPopulation: 'Fictional', requirements: [{ condition: 'x', action: 'y' }] } } });
    id = res.json().requestId as string;
  } finally { await s.close(); } }
  const pending = await advanceToClinical(f.makeStore(), id, 'demo-po');
  { const s = f.makeServer(); try {
    await s.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, headers: demoHeaders('demo-clinician'),
      payload: { eventId: 'fc-clinical', expectedVersion: pending.version, requestRevision: pending.brief.revision, requestSnapshotHash: pending.brief.snapshotHash, logicRevision: pending.logic!.logicRevision, logicHash: pending.logic!.logicHash, checkerReportId: pending.checks!.reportId, decision: 'APPROVE' } });
  } finally { await s.close(); } }
  const approved = (await f.makeStore().getWorkflow(id))!;
  let compileJobId: string;
  { const s = f.makeServer(); try {
    const r = await s.services.compilationHandoff.start({ requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash,
      logicModelRevision: approved.logic!.logicRevision, logicModelHash: approved.logic!.logicHash, expectedVersion: approved.version, eventId: 'fc-compile-start', clinicalApprovalId: approved.clinicalApproval!.eventId }, developerClaims);
    compileJobId = r.job!.jobId;
  } finally { await s.close(); } }
  const model = await f.makeStore().getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: approved.logic!.logicRevision, requestPreview: { requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash } });
  if (model?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
  const compileJob = (await f.makeStore().getCompilationJob(id, compileJobId))!;
  const compileExec = f.artifacts.make(compileJob, model);
  await publishCompileMeta(f, compileExec);

  const s = f.makeServer();
  try {
    // Forged worker identity: an unknown/unauthorized principal is rejected.
    const forged = await s.services.reconciler.reconcile({ requestId: id, jobId: compileJobId, jobType: 'COMPILE_LOGIC', attempt: compileExec.attempt }, 'not-a-worker');
    assert.notEqual(forged.status, 'RECONCILED');
    assert.equal((await f.makeStore().getWorkflow(id))?.status, 'COMPILING'); // unchanged

    // A human (clinician) token at the worker boundary is rejected too.
    const human = await s.services.reconciler.reconcile({ requestId: id, jobId: compileJobId, jobType: 'COMPILE_LOGIC', attempt: compileExec.attempt }, 'clinic');
    assert.notEqual(human.status, 'RECONCILED');

    // Stale attempt: R7 META now at a later attempt than the notification claims.
    await publishCompileMeta(f, { ...compileExec, attempt: 2 }, 2);
    const stale = await s.services.reconciler.reconcile({ requestId: id, jobId: compileJobId, jobType: 'COMPILE_LOGIC', attempt: 1 }, 'svc-compiler');
    assert.notEqual(stale.status, 'RECONCILED');
    assert.equal((await f.makeStore().getWorkflow(id))?.status, 'COMPILING');

    // Unknown job: the reconciler reports UNKNOWN_JOB, advances nothing.
    const unknown = await s.services.reconciler.reconcile({ requestId: id, jobId: 'compile-does-not-exist', attempt: 1 }, 'svc-compiler');
    assert.equal(unknown.status, 'UNKNOWN_JOB');
  } finally { await s.close(); }
});

test('ASSEMBLED fail-closed: a failing/incomplete R6 report blocks release', integration, async (t) => {
  const f = await setup(t);
  let id: string;
  { const s = f.makeServer(); try {
    const res = await s.app.inject({ method: 'POST', url: '/api/requests', headers: demoHeaders('demo-po'),
      payload: { eventId: 'vf-create', expectedVersion: 0, content: { title: 'Fictional verify-fail', objective: 'Gate.', targetPopulation: 'Fictional', requirements: [{ condition: 'x', action: 'y' }] } } });
    id = res.json().requestId as string;
  } finally { await s.close(); } }
  const pending = await advanceToClinical(f.makeStore(), id, 'demo-po');
  { const s = f.makeServer(); try {
    await s.app.inject({ method: 'POST', url: `/api/requests/${id}/clinical-decisions`, headers: demoHeaders('demo-clinician'),
      payload: { eventId: 'vf-clinical', expectedVersion: pending.version, requestRevision: pending.brief.revision, requestSnapshotHash: pending.brief.snapshotHash, logicRevision: pending.logic!.logicRevision, logicHash: pending.logic!.logicHash, checkerReportId: pending.checks!.reportId, decision: 'APPROVE' } });
  } finally { await s.close(); } }
  const approved = (await f.makeStore().getWorkflow(id))!;
  let compileJobId: string;
  { const s = f.makeServer(); try {
    compileJobId = (await s.services.compilationHandoff.start({ requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash,
      logicModelRevision: approved.logic!.logicRevision, logicModelHash: approved.logic!.logicHash, expectedVersion: approved.version, eventId: 'vf-compile-start', clinicalApprovalId: approved.clinicalApproval!.eventId }, developerClaims)).job!.jobId;
  } finally { await s.close(); } }
  const model = await f.makeStore().getSnapshot({ kind: 'LOGIC_MODEL', requestId: id, revision: approved.logic!.logicRevision, requestPreview: { requestId: id, revision: approved.brief.revision, snapshotHash: approved.brief.snapshotHash } });
  if (model?.kind !== 'LOGIC_MODEL') throw new Error('fixture');
  const compileExec = f.artifacts.make((await f.makeStore().getCompilationJob(id, compileJobId))!, model);
  await publishCompileMeta(f, compileExec);
  { const s = f.makeServer(); try { await s.services.reconciler.reconcile({ requestId: id, jobId: compileJobId, jobType: 'COMPILE_LOGIC', attempt: compileExec.attempt }, 'svc-compiler'); } finally { await s.close(); } }
  const waitingVerify = (await f.makeStore().getWorkflow(id))!;
  let verifyJobId: string;
  { const s = f.makeServer(); try {
    verifyJobId = (await s.services.verifyBuildHandoff.start({ requestId: id, revision: waitingVerify.brief.revision, snapshotHash: waitingVerify.brief.snapshotHash,
      logicModelRevision: waitingVerify.logic!.logicRevision, logicModelHash: waitingVerify.logic!.logicHash, expectedVersion: waitingVerify.version, eventId: 'vf-verify-start', compileJobId }, developerClaims)).job!.jobId;
  } finally { await s.close(); } }
  const verifyJob = (await f.makeStore().getVerifyBuildJob(id, verifyJobId))!;
  // A report with incomplete coverage (passed=false) must NOT advance to release.
  const reportDoc = fictionalReport({ passed: false, coverageComplete: false, compileArtifactHash: verifyJob.compileArtifactHash,
    references: { logicModelHash: verifyJob.logicModelHash, clinicalApprovalId: verifyJob.clinicalApprovalId, compilationJobId: verifyJob.compileJobId, packageHash: verifyJob.packageHash } });
  const reportBytes = Buffer.from(JSON.stringify(reportDoc));
  const reportRef = await f.objects.putIfAbsent(`previews/reports/${sha(reportBytes)}.json`, reportBytes);
  await publishVerifyMeta(f, verifyJobId, id, { reportUri: reportRef.uri, reportHash: reportRef.sha256, reportVersionId: reportRef.versionId, passed: false, coverageComplete: false, reportVersion: '2.3.0' });
  { const s = f.makeServer(); try {
    const r = await s.services.reconciler.reconcile({ requestId: id, jobId: verifyJobId, jobType: 'VERIFY_BUILD', attempt: 1 }, 'svc-verifier');
    assert.equal(r.status, 'RECONCILED', r.reason); // accepted as a FAILED result...
  } finally { await s.close(); } }
  // ...but the workflow is FAILED, never WAITING_FOR_RELEASE_APPROVAL, and the artifact is not released.
  assert.equal((await f.makeStore().getWorkflow(id))?.status, 'FAILED');
  { const s = f.makeServer(); try {
    const got = await s.app.inject({ method: 'GET', url: `/api/requests/${id}/artifact`, headers: demoHeaders('demo-po') });
    assert.equal(got.statusCode, 404, got.body);
  } finally { await s.close(); } }
});

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { sha256 } from '../src/hashing.ts';
import { marshall } from '@aws-sdk/util-dynamodb';
import { decodeBody, validatePayload } from '../src/worker.ts';
import { verifyArgs } from '../launch-build.ts';
import { canonicalJson } from '../src/hashing.ts';
import { ARTIFACT_HASH, createTable, Harness, INPUT_HASH, LOGIC, LOGIC_HASH, OK } from './helpers.ts';

let db: DynamoDBDocumentClient;
let h: Harness;

before(() => { db = createTable(); });
beforeEach(() => { h = new Harness(db); });

async function compiled() {
  const payload = h.payload();
  await h.seedJob(payload);
  assert.equal(await h.run(payload), 'SUCCEEDED');
  return { payload, job: await h.job(payload.jobId) };
}

async function verifyPayload(overrides: Record<string, unknown> = {}) {
  const { job } = await compiled();
  const payload = h.payload({
    jobType: 'VERIFY_BUILD', mode: undefined, compileJobId: 'c', packageUri: job.packageUri, packageHash: job.packageHash,
    compileArtifactHash: job.compileArtifactHash, manifestHash: job.manifestHash, ...overrides,
  });
  delete (payload as Record<string, unknown>).mode;
  await h.seedJob(payload);
  h.stages.calls = [];
  return payload;
}

const TESTED_DIR_HASH = sha256('tested');

const report = (p: Record<string, unknown>, passed: boolean) => ({
  schemaVersion: '2.2.0', version: '2.2.0', packageHash: p.packageHash as string, generatedAt: '2026-11-04T00:00:00.000Z', passed, coverageComplete: true,
  toolVersions: { node: 'v20', chtConf: '6.6.1', chtConfTestHarness: '5.0.4', chromiumRevision: '1', python: 'Python 3.11.2' },
  run: { command: ['node', 'run.js'], tz: 'Africa/Nairobi', seed: null, fixedClock: '2026-02-15' },
  references: { snapshotId: null, logicModelHash: INPUT_HASH, revision: null, clinicalApprovalId: null, compilationJobId: null, packageHash: p.packageHash },
  compileArtifactHash: p.compileArtifactHash as string, testedDirHash: TESTED_DIR_HASH, patientSetHash: sha256('patients'), goldenCasesHash: null, integrityChecks: [],
  coverage: { method: 'observed-outcome', branchSource: 'manifest', sampleWarning: null, totalBranches: 0, coveredBranches: 0, coveredBranchIds: [], uncoveredBranchIds: [], uncoveredBranches: [] },
  cases: [], disagreements: [],
});

describe('COMPILE_LOGIC happy path', () => {
  it('runs the stages, records the result, audits it and deletes the message', async () => {
    const { payload, job } = await compiled();
    assert.deepEqual(h.stages.calls, ['compile', 'convert']);
    assert.equal(job.status, 'SUCCEEDED');
    assert.equal(job.inputHash, INPUT_HASH);
    assert.equal(job.snapshotHash, LOGIC_HASH);
    assert.equal(job.compileArtifactHash, ARTIFACT_HASH);
    assert.equal(job.templateHash, 'tpl');
    assert.equal(job.toolVersions.compilerCommit, '7f488e6');
    assert.equal(job.toolVersions.compileImageDigest, 'compile:1@sha256:test');
    assert.equal(job.leaseOwner, undefined);
    assert.equal(job.runnerActorId, 'worker-a-compile');
    assert.equal(job.toolVersions.compiler, '7f488e6');
    assert.equal(job.toolVersions.chtConf, '6.6.1');
    assert.equal(job.compilerExitCode, 0);
    assert.equal(job.chtConfStatus, 'PASSED');
    assert.match(job.packageVersionId, /project\.tgz$/);
    assert.match(job.manifestVersionId, /manifest\.json$/);
    assert.match(job.compileReportUri, /compile-manifest\.json$/);
    assert.match(job.compileReportVersionId, /compile-manifest\.json$/);
    assert.equal(sha256(await h.artifacts.get(job.compileReportUri)), job.compileReportHash);
    assert.equal(sha256((await h.artifacts.get(job.packageUri))), job.packageHash);
    assert.deepEqual((await h.audits(payload.requestId)).sort(), ['job_started', 'job_succeeded']);
    assert.equal(h.queue.deleted.length, 1);
  });

  it('writes the bare LogicModel to /in, not the envelope', async () => {
    let written = '';
    const original = h.stages.compile.bind(h.stages);
    h.stages.compile = async (input) => {
      const { readFileSync } = await import('node:fs');
      written = readFileSync(`${input.inDir}/logic.json`, 'utf8');
      return original(input);
    };
    await compiled();
    assert.equal(sha256(written), INPUT_HASH);
    assert.ok(!written.includes('LOGIC_MODEL'));
  });
});

describe('duplicates and takeover', () => {
  it('a duplicate message after completion does not start a second run', async () => {
    const { payload } = await compiled();
    h.stages.calls = [];
    assert.equal(await h.run(payload), 'SKIPPED');
    assert.deepEqual(h.stages.calls, []);
    assert.equal(h.queue.deleted.length, 2);
  });

  it('a second delivery during a live lease runs nothing and keeps the message for takeover', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    await h.store().take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'other', receiveCount: 1, workerId: 'worker-z', leaseSeconds: 900 });
    assert.equal(await h.run(payload), 'SKIPPED');
    assert.deepEqual(h.stages.calls, []);
    assert.deepEqual(h.queue.deleted, []);
    assert.ok(h.queue.visibility[0]! >= 900);
  });

  it('a crash mid-run is taken over on the same MessageId after the lease expires, with one result', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    const crashed = await h.store().take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'same', receiveCount: 1, workerId: 'crashed', leaseSeconds: 900 });
    assert.equal(crashed.kind, 'TAKEN');
    h.now += 901_000;
    const message = h.message(payload, 2, 'same');
    assert.equal(await h.worker().handle(message), 'SUCCEEDED');
    const job = await h.job(payload.jobId);
    assert.equal(job.attempt, 2);
    assert.equal(job.status, 'SUCCEEDED');

    const zombie = await h.store().commitResult(
      { jobId: payload.jobId, requestId: payload.requestId, workerId: 'crashed', attempt: 1 },
      { status: 'FAILED' } as never,
    );
    assert.equal(zombie, false);
    assert.equal((await h.job(payload.jobId)).status, 'SUCCEEDED');
    assert.equal((await h.audits(payload.requestId)).filter((e) => e === 'job_succeeded').length, 1);
  });

  it('a stale worker cannot heartbeat after takeover', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    const store = h.store();
    await store.take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'a', receiveCount: 1, workerId: 'old', leaseSeconds: 900 });
    h.now += 901_000;
    await store.take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'a', receiveCount: 2, workerId: 'new', leaseSeconds: 900 });
    assert.equal(await store.heartbeat({ jobId: payload.jobId, requestId: payload.requestId, workerId: 'old', attempt: 1 }, 900), false);
    assert.equal(await store.heartbeat({ jobId: payload.jobId, requestId: payload.requestId, workerId: 'new', attempt: 2 }, 900), true);
  });

  it('a message with no JOB META stays on the queue for the DLQ', async () => {
    assert.equal(await h.run(h.payload()), 'LEFT_ON_QUEUE');
    assert.deepEqual(h.queue.deleted, []);
  });

  it('a job status the runner does not know is not acked away', async () => {
    const payload = h.payload();
    await db.send(new (await import('@aws-sdk/lib-dynamodb')).PutCommand({ TableName: 'cht-nocode-runner-test', Item: { pk: `JOB#${payload.jobId}`, sk: 'META', status: 'requested' } }));
    await assert.rejects(h.run(payload), /unexpected status requested/);
    assert.deepEqual(h.queue.deleted, []);
  });
});

describe('fails closed', () => {
  it('a snapshot hash mismatch fails terminally before any stage', async () => {
    const payload = h.payload({ logicModelHash: `sha256:${'0'.repeat(64)}` });
    await h.seedJob(payload);
    assert.equal(await h.run(payload), 'FAILED');
    const job = await h.job(payload.jobId);
    assert.equal(job.errorCode, 'HASH_MISMATCH');
    assert.equal(job.retryable, false);
    assert.deepEqual(h.stages.calls, []);
  });

  for (const [name, approval] of Object.entries({
    missing: undefined,
    rejected: { decision: 'rejected', logicModelHash: LOGIC_HASH, superseded: false },
    'for other logic': { decision: 'approved', logicModelHash: 'sha256:other', superseded: false },
    superseded: { decision: 'approved', logicModelHash: LOGIC_HASH, superseded: true },
    'status superseded': { decision: 'approved', logicModelHash: LOGIC_HASH, status: 'SUPERSEDED' },
  })) {
    it(`an approved job with an approval that is ${name} fails APPROVAL_INVALID`, async () => {
      const payload = h.payload({ mode: 'approved', clinicalApprovalId: 'a1' });
      await h.seedJob(payload);
      if (approval) await h.seedApproval(payload.requestId, 'a1', approval);
      assert.equal(await h.run(payload), 'FAILED');
      assert.equal((await h.job(payload.jobId)).errorCode, 'APPROVAL_INVALID');
      assert.deepEqual(h.stages.calls, []);
    });
  }

  it('a valid approval lets an approved build through, unwatermarked, under builds/', async () => {
    const payload = h.payload({ mode: 'approved', clinicalApprovalId: 'a1' });
    await h.seedJob(payload);
    await h.seedApproval(payload.requestId, 'a1', { decision: 'approved', logicModelHash: LOGIC_HASH.slice('sha256:'.length), superseded: false, status: 'APPROVED' });
    assert.equal(await h.run(payload), 'SUCCEEDED');
    assert.equal(h.stages.compileInputs[0]!.watermark, undefined);
    assert.ok(h.keys().some((key) => key.startsWith(`builds/${LOGIC_HASH}/${payload.jobId}/attempt-1/project.tgz`)));
  });

  for (const [field, value] of [['inputHash', 'wrong'], ['snapshotHash', 'wrong']] as const) {
    it(`a manifest with the wrong ${field} fails INPUT_HASH_MISMATCH and packages nothing`, async () => {
      const payload = h.payload();
      await h.seedJob(payload);
      h.stages.manifestOverride = { [field]: value };
      assert.equal(await h.run(payload), 'FAILED');
      assert.equal((await h.job(payload.jobId)).errorCode, 'INPUT_HASH_MISMATCH');
      assert.ok(!h.keys().some((key) => key.endsWith('project.tgz')));
    });
  }

  it('an invalid payload fails the PENDING job as INVALID_PAYLOAD and is deleted', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    assert.equal(await h.run({ ...payload, surprise: true }), 'FAILED');
    const job = await h.job(payload.jobId);
    assert.equal(job.errorCode, 'INVALID_PAYLOAD');
    assert.equal(job.runnerActorId, 'worker-a-compile');
    assert.equal(h.queue.deleted.length, 1);
  });

  it('an invalid payload cannot fail a job another worker is running', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    await h.store().take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'x', receiveCount: 1, workerId: 'owner', leaseSeconds: 900 });
    assert.equal(await h.run({ ...payload, surprise: true }), 'LEFT_ON_QUEUE');
    assert.equal((await h.job(payload.jobId)).status, 'RUNNING');
    assert.deepEqual(h.queue.deleted, []);
  });

  it('an invalid payload whose failure cannot be recorded is not deleted', async () => {
    const payload = h.payload();
    assert.equal(await h.run({ ...payload, surprise: true }), 'LEFT_ON_QUEUE');
    assert.deepEqual(h.queue.deleted, []);
  });

  it('a snapshot outside the artifact bucket is rejected', async () => {
    const payload = h.payload({ snapshotUri: 's3://someone-else/snapshots/x.json' });
    await h.seedJob(payload);
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'INVALID_PAYLOAD');
  });

  it('runs a payload delivered as a stream record by the outbox Pipe', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    const attribute = { M: marshall(payload, { removeUndefinedValues: true }) };
    assert.equal(attribute.M.revision!.N, '1');
    assert.equal(attribute.M.clinicalApprovalId!.NULL, true);
    const record = { eventName: 'INSERT', dynamodb: { Keys: { sk: { S: 'OUTBOX' } }, NewImage: { sk: { S: 'OUTBOX' }, payload: attribute } } };
    assert.equal(await h.run(record), 'SUCCEEDED');
  });

  it('decodes each form the jobs queue can carry', () => {
    const record = (payload: unknown) => ({ dynamodb: { NewImage: { payload } } });
    const map = { M: { jobId: { S: 'a' }, revision: { N: '1' } } };
    assert.deepEqual(decodeBody(JSON.stringify(record(map))), { jobId: 'a', revision: 1 });
    assert.deepEqual(decodeBody(JSON.stringify([record(map)])), { jobId: 'a', revision: 1 });
    assert.deepEqual(decodeBody(JSON.stringify(record({ S: '{"jobId":"a"}' }))), { jobId: 'a' });
    assert.deepEqual(decodeBody('{"jobId":"a","revision":1}'), { jobId: 'a', revision: 1 });
    assert.equal(decodeBody(JSON.stringify(record({ S: 'not json' }))), undefined);
    assert.equal(decodeBody(JSON.stringify(record({ BOGUS: 'x' }))), undefined);
    // What the old input template produced.
    assert.equal(decodeBody('{M:{jobId:{S:smoke-1},revision:{N:1}}}'), undefined);
  });

  it('accepts payloads still on contract 1.0.0 and rejects unknown versions', () => {
    assert.ok('payload' in validatePayload(h.payload({ contractVersion: '1.0.0' })));
    assert.ok('error' in validatePayload(h.payload({ contractVersion: '9.9.9' })));
  });

  it('golden case fields must come together', () => {
    assert.ok('payload' in validatePayload(h.payload({ goldenCasesUri: 's3://b/g.json', goldenCasesHash: 'sha256:g' })));
    assert.ok('error' in validatePayload(h.payload({ goldenCasesUri: 's3://b/g.json' })));
    assert.ok('error' in validatePayload(h.payload({ goldenCasesHash: 'sha256:g' })));
  });

  it('COMPILE_LOGIC without a mode is invalid', () => {
    const payload = h.payload();
    delete (payload as Record<string, unknown>).mode;
    assert.ok('error' in validatePayload(payload));
  });
});

describe('preview isolation', () => {
  it('a preview build is watermarked and never writes under builds/', async () => {
    await compiled();
    assert.equal(h.stages.compileInputs[0]!.watermark, 'PREVIEW - NOT FOR RELEASE');
    const uploaded = h.keys().filter((key) => !key.startsWith('snapshots/'));
    assert.ok(uploaded.length > 0);
    assert.ok(uploaded.every((key) => key.startsWith('previews/')), uploaded.join());
  });
});

describe('exit codes and retries', () => {
  it('compiler exit 1 is terminal MODEL_REJECTED with compileErrors and no retry', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    const errors = [{ code: 'OPEN_BLOCKING_AMBIGUITY', path: '$.x', message: 'no' }];
    h.stages.compileResult = { ...OK, exitCode: 1, stderr: JSON.stringify({ ok: false, errors }) };
    assert.equal(await h.run(payload), 'FAILED');
    const job = await h.job(payload.jobId);
    assert.equal(job.errorCode, 'MODEL_REJECTED');
    assert.equal(job.retryable, false);
    assert.deepEqual(job.compileErrors, errors);
    assert.equal(job.compilerExitCode, 1);
    assert.equal(job.chtConfStatus, 'NOT_RUN');
    assert.equal(job.failureKind, 'COMPILER_REJECTED');
    assert.equal(h.queue.deleted.length, 1);
    assert.deepEqual(h.stages.calls, ['compile']);
  });

  it('records R2 failure details when the last delivery ends each kind of failure', async () => {
    const cases: [string, Partial<typeof OK>, string, number | null, string, string][] = [
      ['compile', { exitCode: 2 }, 'COMPILE_INFRA_ERROR', 2, 'NOT_RUN', 'COMPILER_USAGE_OR_FILE_ERROR'],
      ['compile', { exitCode: 137 }, 'COMPILE_INFRA_ERROR', null, 'NOT_RUN', 'RUNNER_FAILED'],
      ['compile', { timedOut: true }, 'TIMEOUT', null, 'NOT_RUN', 'TIMED_OUT'],
      ['convert', { exitCode: 1 }, 'CONVERT_FAILED', 0, 'FAILED', 'CHT_CONVERSION_FAILED'],
    ];
    for (const [stage, result, code, exit, cht, kind] of cases) {
      const payload = h.payload();
      await h.seedJob(payload);
      h.stages.compileResult = stage === 'compile' ? { ...OK, ...result } : OK;
      h.stages.convertResult = stage === 'convert' ? { ...OK, ...result } : OK;
      assert.equal(await h.run(payload, 3), 'FAILED');
      const job = await h.job(payload.jobId);
      assert.deepEqual([job.errorCode, job.compilerExitCode, job.chtConfStatus, job.failureKind], [code, exit, cht, kind]);
    }
  });

  it('exit 1 without the compiler error JSON is infrastructure, not a model rejection', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.compileResult = { ...OK, exitCode: 1, stderr: "Error: Cannot find module '/compiler/src/cli.ts'" };
    assert.equal(await h.run(payload), 'RETRYING');
    assert.equal((await h.job(payload.jobId)).lastErrorCode, 'COMPILE_INFRA_ERROR');
  });

  it('compiler exit 2 returns to PENDING, redelivers in 30s, and the retry succeeds as attempt 2', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.compileResult = { ...OK, exitCode: 2, stderr: 'bad template' };
    const worker = h.worker();
    assert.equal(await worker.handle(h.message(payload, 1, 'retry-me')), 'RETRYING');
    let job = await h.job(payload.jobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.leaseOwner, undefined);
    assert.deepEqual(h.queue.deleted, []);
    assert.deepEqual(h.queue.visibility, [30]);
    assert.ok((await h.audits(payload.requestId)).includes('attempt_failed_retryable'));

    h.stages.compileResult = OK;
    assert.equal(await worker.handle(h.message(payload, 2, 'retry-me')), 'SUCCEEDED');
    job = await h.job(payload.jobId);
    assert.equal(job.status, 'SUCCEEDED');
    assert.equal(job.attempt, 2);
    assert.ok(h.keys().some((key) => key.includes('/attempt-2/project.tgz')));
  });

  it('a retryable failure on the last delivery ends FAILED instead of stranding the job', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.compileResult = { ...OK, exitCode: 2, stderr: 'bad template' };
    assert.equal(await h.run(payload, 3), 'FAILED');
    const job = await h.job(payload.jobId);
    assert.equal(job.errorCode, 'COMPILE_INFRA_ERROR');
    assert.equal(job.retryable, true);
    assert.equal(h.queue.deleted.length, 1);
  });

  it('a compile timeout is retryable TIMEOUT', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.compileResult = { ...OK, exitCode: 137, timedOut: true };
    assert.equal(await h.run(payload), 'RETRYING');
    assert.equal((await h.job(payload.jobId)).lastErrorCode, 'TIMEOUT');
  });

  it('cht rejecting the forms is terminal CONVERT_FAILED and keeps the log', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.convertResult = { ...OK, exitCode: 1 };
    assert.equal(await h.run(payload), 'FAILED');
    const job = await h.job(payload.jobId);
    assert.equal(job.errorCode, 'CONVERT_FAILED');
    assert.ok(String(job.logUri).endsWith('convert.log'));
    assert.ok(h.keys().some((key) => key.endsWith('compile.log')));
  });

  it('a convert container that never started is retryable', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.writeConvertLog = false;
    h.stages.convertResult = { ...OK, exitCode: 125, stderr: 'docker: error' };
    assert.equal(await h.run(payload), 'RETRYING');
  });

  it('a missing snapshot object is retryable, not a hash failure', async () => {
    const payload = h.payload({ snapshotUri: 's3://test-bucket/snapshots/absent.json' });
    await h.seedJob(payload);
    assert.equal(await h.run(payload), 'RETRYING');
  });

  it('losing the lease mid-run records nothing and leaves the message', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    h.stages.onCompile = () => { h.now += 901_000; };
    const worker = h.worker();
    const takeover = h.store();
    const original = h.stages.convert.bind(h.stages);
    h.stages.convert = async (input) => {
      await takeover.take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'thief', receiveCount: 2, workerId: 'worker-b', leaseSeconds: 900 });
      return original(input);
    };
    assert.equal(await worker.handle(h.message(payload)), 'LEASE_LOST');
    const job = await h.job(payload.jobId);
    assert.equal(job.status, 'RUNNING');
    assert.equal(job.leaseOwner, 'worker-b');
    assert.deepEqual(h.queue.deleted, []);
  });
});

describe('baseline and task window', () => {
  function seedBaseline(rows = '[]') {
    const manifestJson = '{"formId":"f"}';
    const prefix = 'builds/old/job/attempt-1';
    h.artifacts.seed(`${prefix}/compile-manifest.json`, manifestJson);
    h.artifacts.seed(`${prefix}/compile-rows.json`, rows);
    h.artifacts.seed(`${prefix}/manifest.json`, JSON.stringify({
      files: [{ path: 'compile-manifest.json', sha256: sha256(manifestJson) }, { path: 'compile-rows.json', sha256: sha256('[]') }],
    }));
    return `s3://test-bucket/${prefix}`;
  }

  it('passes the verified baseline and task window to the compiler and uploads the diff', async () => {
    const payload = h.payload({ baselineUri: seedBaseline(), taskWindow: '0,2' });
    await h.seedJob(payload);
    assert.equal(await h.run(payload), 'SUCCEEDED');
    assert.ok(h.stages.compileInputs[0]!.baselineDir);
    assert.equal(h.stages.compileInputs[0]!.taskWindow, '0,2');
    const job = await h.job(payload.jobId);
    assert.ok(String(job.compileDiffUri).endsWith('compile-diff.json'));
    assert.ok(h.artifacts.objects.has(String(job.compileDiffUri).replace('s3://test-bucket/', '')));
  });

  it('a tampered baseline fails HASH_MISMATCH before compiling', async () => {
    const payload = h.payload({ baselineUri: seedBaseline('[{"tampered":true}]') });
    await h.seedJob(payload);
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'HASH_MISMATCH');
    assert.deepEqual(h.stages.calls, []);
  });

  it('no baseline means no diff field', async () => {
    const { job } = await compiled();
    assert.equal(job.compileDiffUri, undefined);
  });
});

describe('VERIFY_BUILD', () => {
  it('a tampered project.tgz fails HASH_MISMATCH without running the verifier', async () => {
    const payload = await verifyPayload({ packageHash: `sha256:${'f'.repeat(64)}` });
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'HASH_MISMATCH');
    assert.deepEqual(h.stages.calls, []);
  });

  it('verifier exit 0 with a valid report succeeds, uploads it and copies its fields', async () => {
    const payload = await verifyPayload();
    h.stages.report = report(payload, true);
    assert.equal(await h.run(payload), 'SUCCEEDED');
    const job = await h.job(payload.jobId);
    assert.equal(job.verificationPassed, true);
    assert.equal(job.coverageComplete, true);
    assert.equal(job.testedDirHash, TESTED_DIR_HASH);
    assert.equal(job.reportVersion, '2.2.0');
    assert.equal(job.runnerActorId, 'worker-a-verify');
    assert.match(job.reportVersionId, /report\.json$/);
    assert.ok(h.artifacts.objects.has(String(job.reportUri).replace('s3://test-bucket/', '')));
  });

  it('verifier exit 1 with a valid report ends SUCCEEDED with verificationPassed=false', async () => {
    const payload = await verifyPayload();
    h.stages.verifyResult = { ...OK, exitCode: 1 };
    h.stages.report = report(payload, false);
    assert.equal(await h.run(payload), 'SUCCEEDED');
    assert.equal((await h.job(payload.jobId)).verificationPassed, false);
  });

  it('verifier exit 2 is retryable VERIFY_ERROR', async () => {
    const payload = await verifyPayload();
    h.stages.verifyResult = { ...OK, exitCode: 2 };
    assert.equal(await h.run(payload), 'RETRYING');
    assert.equal((await h.job(payload.jobId)).lastErrorCode, 'VERIFY_ERROR');
  });

  it('exit 0 with a missing report counts as exit 2', async () => {
    const payload = await verifyPayload();
    assert.equal(await h.run(payload), 'RETRYING');
  });

  it('exit 0 with an invalid report counts as exit 2', async () => {
    const payload = await verifyPayload();
    h.stages.report = { passed: true };
    assert.equal(await h.run(payload), 'RETRYING');
  });

  it('gives the verifier the checked logic and the inputHash as LOGIC_MODEL_HASH', async () => {
    const payload: Record<string, unknown> = await verifyPayload();
    const packageHex = String(payload.packageHash);
    h.stages.report = report(payload, true);
    assert.equal(await h.run({ ...payload, packageHash: `sha256:${packageHex}` }), 'SUCCEEDED');
    const input = h.stages.verifyInputs[0]!;
    assert.equal(input.inputHash, INPUT_HASH);
    assert.notEqual(input.inputHash, payload.logicModelHash);
    assert.equal(input.packageHash, packageHex);
    assert.equal(input.hasGoldenCases, false);
    assert.deepEqual(h.stages.verifyFiles[0], { 'logic.json': canonicalJson(LOGIC) });
  });

  it('a snapshot that does not match the job fails HASH_MISMATCH before the verifier', async () => {
    const payload = await verifyPayload({ logicModelHash: `sha256:${'a'.repeat(64)}` });
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'HASH_MISMATCH');
    assert.deepEqual(h.stages.calls, []);
  });

  it('a snapshot whose logic differs from the package fails INPUT_HASH_MISMATCH', async () => {
    const envelope = Buffer.from(canonicalJson({ kind: 'LOGIC_MODEL', revision: 1, content: { ...LOGIC, a: 2 } }));
    const hash = `sha256:${sha256(envelope)}`;
    const payload = await verifyPayload({ logicModelHash: hash, snapshotUri: h.artifacts.seed(`snapshots/${hash}.json`, envelope) });
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'INPUT_HASH_MISMATCH');
    assert.deepEqual(h.stages.calls, []);
  });

  it('checks and mounts golden cases only when the job has them', async () => {
    const golden = '[{"id":"g"}]';
    const payload = await verifyPayload({ goldenCasesUri: h.artifacts.seed('sources/golden.json', golden), goldenCasesHash: `sha256:${sha256(golden)}` });
    h.stages.report = report(payload, true);
    assert.equal(await h.run(payload), 'SUCCEEDED');
    assert.equal(h.stages.verifyInputs[0]!.hasGoldenCases, true);
    assert.equal(h.stages.verifyFiles[0]!['golden-cases.json'], golden);
  });

  it('golden cases with the wrong hash fail HASH_MISMATCH', async () => {
    const payload = await verifyPayload({ goldenCasesUri: h.artifacts.seed('sources/golden.json', 'x'), goldenCasesHash: sha256('y') });
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'HASH_MISMATCH');
    assert.deepEqual(h.stages.calls, []);
  });

  it('golden cases outside the artifact bucket are rejected', async () => {
    const payload = await verifyPayload({ goldenCasesUri: 's3://someone-else/golden.json', goldenCasesHash: sha256('y') });
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'INVALID_PAYLOAD');
  });

  it('builds the verify container with the contract env and read-only mounts', () => {
    const base = { image: 'i', projectDir: '/p', inDir: '/n', verifierDir: '/v', outDir: '/o', packageHash: 'pkg', compileArtifactHash: 'art', inputHash: 'input' };
    const args = verifyArgs({ ...base, hasGoldenCases: false }, 'name');
    for (const expected of ['PACKAGE_HASH=pkg', 'COMPILE_ARTIFACT_HASH=art', 'LOGIC_MODEL_HASH=input', 'CHT_CONFIG_DIR=/project', 'OUT_DIR=/out', 'TZ=Africa/Nairobi', '/p:/project:ro', '/n:/in:ro', '/v:/verifier:ro']) {
      assert.ok(args.includes(expected), expected);
    }
    assert.ok(!args.includes('GOLDEN_CASES_FILE=/in/golden-cases.json'));
    assert.ok(verifyArgs({ ...base, hasGoldenCases: true }, 'name').includes('GOLDEN_CASES_FILE=/in/golden-cases.json'));
  });

  it('a job dir it cannot clean up does not change the outcome', async () => {
    const payload = await verifyPayload();
    h.stages.report = report(payload, true);
    const fakeVerify = h.stages.verify.bind(h.stages);
    let locked = '';
    h.stages.verify = async (input) => {
      locked = join(input.outDir, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'file'), 'x');
      chmodSync(locked, 0o555);
      return fakeVerify(input);
    };
    try {
      assert.equal(await h.run(payload), 'SUCCEEDED');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  const crossChecks: [string, (r: ReturnType<typeof report>) => void][] = [
    ['report.passed disagreeing with the exit code', (r) => { r.passed = false; }],
    ['a different report.packageHash', (r) => { r.packageHash = 'other'; }],
    ['a different report.compileArtifactHash', (r) => { r.compileArtifactHash = sha256('other'); }],
  ];
  for (const [name, tamper] of crossChecks) {
    it(`${name} is terminal VERIFY_ERROR`, async () => {
      const payload = await verifyPayload();
      const body = report(payload, true);
      tamper(body);
      h.stages.report = body;
      assert.equal(await h.run(payload), 'FAILED');
      assert.equal((await h.job(payload.jobId)).errorCode, 'VERIFY_ERROR');
    });
  }
});

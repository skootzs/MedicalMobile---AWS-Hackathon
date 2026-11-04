import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { sha256 } from '../src/hashing.ts';
import { validatePayload } from '../src/worker.ts';
import { createTable, Harness, INPUT_HASH, LOGIC_HASH, OK } from './helpers.ts';

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

const report = (p: Record<string, unknown>, passed: boolean) => ({
  version: '2.0.0', passed, coverageComplete: true, testedDirHash: 'tested', packageHash: p.packageHash, compileArtifactHash: p.compileArtifactHash,
});

describe('COMPILE_LOGIC happy path', () => {
  it('runs the stages, records the result, audits it and deletes the message', async () => {
    const { payload, job } = await compiled();
    assert.deepEqual(h.stages.calls, ['compile', 'convert']);
    assert.equal(job.status, 'SUCCEEDED');
    assert.equal(job.inputHash, INPUT_HASH);
    assert.equal(job.snapshotHash, LOGIC_HASH);
    assert.equal(job.compileArtifactHash, 'art');
    assert.equal(job.templateHash, 'tpl');
    assert.equal(job.toolVersions.compilerCommit, '7f488e6');
    assert.equal(job.toolVersions.compileImageDigest, 'compile:1@sha256:test');
    assert.equal(job.leaseOwner, undefined);
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
    assert.equal((await h.job(payload.jobId)).errorCode, 'INVALID_PAYLOAD');
    assert.equal(h.queue.deleted.length, 1);
  });

  it('an invalid payload cannot fail a job another worker is running', async () => {
    const payload = h.payload();
    await h.seedJob(payload);
    await h.store().take({ jobId: payload.jobId, requestId: payload.requestId, messageId: 'x', receiveCount: 1, workerId: 'owner', leaseSeconds: 900 });
    await h.run({ ...payload, surprise: true });
    assert.equal((await h.job(payload.jobId)).status, 'RUNNING');
  });

  it('a snapshot outside the artifact bucket is rejected', async () => {
    const payload = h.payload({ snapshotUri: 's3://someone-else/snapshots/x.json' });
    await h.seedJob(payload);
    assert.equal(await h.run(payload), 'FAILED');
    assert.equal((await h.job(payload.jobId)).errorCode, 'INVALID_PAYLOAD');
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
    assert.equal(h.queue.deleted.length, 1);
    assert.deepEqual(h.stages.calls, ['compile']);
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
    assert.equal(job.testedDirHash, 'tested');
    assert.equal(job.reportVersion, '2.0.0');
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

  const crossChecks: [string, (r: ReturnType<typeof report>) => void][] = [
    ['report.passed disagreeing with the exit code', (r) => { r.passed = false; }],
    ['a different report.packageHash', (r) => { r.packageHash = 'other'; }],
    ['a different report.compileArtifactHash', (r) => { r.compileArtifactHash = 'other'; }],
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVerifyBuildIntent, validVerifyBuildIntent, verifyBuildOutbox, toVerifyBuildPayload, toR7Hash, R7_CONTRACT_VERSION,
} from '../src/verify-build-contracts.ts';
import { validateVerifyBuildPayload } from '../src/r7-handoff-contract.ts';

const HASH = (d: string) => d.repeat(64);
const input = () => ({
  requestId: 'req-1', revision: 1,
  requestPreview: { requestId: 'req-1', revision: 1, snapshotHash: HASH('a') },
  logicModelRevision: 1, logicModelHash: HASH('b'), clinicalApprovalId: 'clin-1',
  compileJobId: 'compile-x', packageHash: HASH('c'), packageUri: 's3://bucket/builds/compile-x/project.tgz',
  packageVersionId: 'v1', manifestHash: HASH('d'), compileArtifactHash: HASH('e'),
  snapshotUri: 's3://bucket/snapshots/' + HASH('b') + '.json', checkerReportId: 'check-1',
  checkReportHash: HASH('7'),
  sourceWorkflowVersion: 5, handoffEventId: 'ev-verify', createdBy: 'orch-1', createdAt: '2026-11-04T00:00:00.000Z',
});

test('createVerifyBuildIntent is deterministic and binds the exact artifact', () => {
  const a = createVerifyBuildIntent(input());
  const b = createVerifyBuildIntent(input());
  assert.equal(a.jobId, b.jobId);
  assert.ok(a.jobId.startsWith('verify-'));
  assert.equal(a.jobType, 'VERIFY_BUILD');
  assert.equal(a.workflowVersion, 6); // sourceWorkflowVersion + 1
  assert.equal(a.status, 'PENDING');
  // Changing the package digest changes the job identity.
  const c = createVerifyBuildIntent({ ...input(), packageHash: HASH('f') });
  assert.notEqual(a.jobId, c.jobId);
});

test('checkReportHash and snapshotUri are evidence, not part of the job identity', () => {
  // jobId/idempotency must stay stable so existing stored jobs remain idempotent.
  const a = createVerifyBuildIntent(input());
  const b = createVerifyBuildIntent({ ...input(), checkReportHash: HASH('9'), snapshotUri: 's3://other/snapshots/x.json' });
  assert.equal(a.jobId, b.jobId);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
});

test('validVerifyBuildIntent accepts a well-formed intent and rejects tampering', () => {
  const job = createVerifyBuildIntent(input());
  assert.equal(validVerifyBuildIntent(job), true);
  assert.equal(validVerifyBuildIntent({ ...job, packageHash: HASH('f') }), false); // id no longer matches
  assert.equal(validVerifyBuildIntent({ ...job, jobType: 'COMPILE_LOGIC' } as never), false);
  assert.equal(validVerifyBuildIntent({ ...job, extra: 1 } as never), false);
});

test('outbox carries the exact validated R7 wire payload R7 forwards', () => {
  const job = createVerifyBuildIntent(input());
  const outbox = verifyBuildOutbox(job);
  assert.deepEqual(outbox, {
    pk: `JOB#${job.jobId}`, sk: 'OUTBOX', jobId: job.jobId, jobType: 'VERIFY_BUILD',
    requestId: 'req-1', idempotencyKey: job.idempotencyKey, createdAt: job.createdAt, status: 'PENDING',
    payload: toVerifyBuildPayload(job),
  });
  // The payload embedded in the outbox must itself be schema-valid for R7.
  assert.equal(validateVerifyBuildPayload(outbox.payload).ok, true);
});

test('toVerifyBuildPayload reconciles raw-hex -> R7 sha256: prefix only at the boundary', () => {
  const job = createVerifyBuildIntent(input());
  const payload = toVerifyBuildPayload(job);
  assert.equal(payload.contractVersion, R7_CONTRACT_VERSION);
  assert.equal(R7_CONTRACT_VERSION, '1.0.0'); // R2 deliberately emits 1.0.0
  assert.equal(payload.logicModelHash, toR7Hash(job.logicModelHash));
  assert.equal(payload.packageHash, `sha256:${job.packageHash}`);
  assert.equal(payload.manifestHash, `sha256:${job.manifestHash}`);
  // checkReportHash is the canonical R4 checker-report digest, NOT compileArtifactHash.
  assert.equal(payload.checkReportHash, toR7Hash(job.checkReportHash));
  assert.notEqual(payload.checkReportHash, payload.compileArtifactHash);
  // snapshotUri is the real immutable S3 object URI threaded through the intent.
  assert.equal(payload.snapshotUri, job.snapshotUri);
  // The internal intent keeps raw hex; only the payload is prefixed.
  assert.match(job.logicModelHash, /^[a-f0-9]{64}$/);
});

test('the emitted payload omits golden-case fields (R2 owns no golden reference)', () => {
  const payload = toVerifyBuildPayload(createVerifyBuildIntent(input()));
  assert.ok(!('goldenCasesUri' in payload));
  assert.ok(!('goldenCasesHash' in payload));
});

test('the emitted payload satisfies R7 VerifyBuildPayload schema', () => {
  const job = createVerifyBuildIntent(input());
  const result = validateVerifyBuildPayload(toVerifyBuildPayload(job));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('R7 1.1.0 schema still accepts contractVersion 1.0.0 and the optional golden pair', () => {
  const payload = toVerifyBuildPayload(createVerifyBuildIntent(input())) as Record<string, unknown>;
  // 1.0.0 (what R2 emits) and 1.1.0 are both accepted.
  assert.equal(validateVerifyBuildPayload({ ...payload, contractVersion: '1.0.0' }).ok, true);
  assert.equal(validateVerifyBuildPayload({ ...payload, contractVersion: '1.1.0' }).ok, true);
  // Golden cases are optional but must be supplied together (dependency rule).
  assert.equal(validateVerifyBuildPayload({ ...payload, goldenCasesUri: 's3://x', goldenCasesHash: HASH('8') }).ok, true);
  assert.equal(validateVerifyBuildPayload({ ...payload, goldenCasesUri: 's3://x' }).ok, false);
  assert.equal(validateVerifyBuildPayload({ ...payload, goldenCasesHash: HASH('8') }).ok, false);
});

test('R7 schema rejects a payload missing verify-specific fields or with wrong version', () => {
  const job = createVerifyBuildIntent(input());
  const payload = toVerifyBuildPayload(job) as Record<string, unknown>;
  const { packageUri: _omit, ...missing } = payload;
  assert.equal(validateVerifyBuildPayload(missing).ok, false);
  assert.equal(validateVerifyBuildPayload({ ...payload, contractVersion: '2.0.0' }).ok, false);
  assert.equal(validateVerifyBuildPayload({ ...payload, jobType: 'COMPILE_LOGIC' }).ok, false);
});

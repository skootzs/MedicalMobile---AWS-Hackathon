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
  compileJobId: 'compile-x', packageHash: HASH('c'), packageUri: 's3://r2/builds/compile-x/project.tgz',
  packageVersionId: 'v1', manifestHash: HASH('d'), compileArtifactHash: HASH('e'),
  snapshotUri: 's3://r2/snapshots/' + HASH('b') + '.json', checkerReportId: 'check-1',
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

test('validVerifyBuildIntent accepts a well-formed intent and rejects tampering', () => {
  const job = createVerifyBuildIntent(input());
  assert.equal(validVerifyBuildIntent(job), true);
  assert.equal(validVerifyBuildIntent({ ...job, packageHash: HASH('f') }), false); // id no longer matches
  assert.equal(validVerifyBuildIntent({ ...job, jobType: 'COMPILE_LOGIC' } as never), false);
  assert.equal(validVerifyBuildIntent({ ...job, extra: 1 } as never), false);
});

test('outbox is a thin pointer to the job', () => {
  const job = createVerifyBuildIntent(input());
  assert.deepEqual(verifyBuildOutbox(job), {
    pk: `JOB#${job.jobId}`, sk: 'OUTBOX', jobId: job.jobId, jobType: 'VERIFY_BUILD',
    requestId: 'req-1', idempotencyKey: job.idempotencyKey, createdAt: job.createdAt, status: 'PENDING',
  });
});

test('toVerifyBuildPayload reconciles raw-hex -> R7 sha256: prefix only at the boundary', () => {
  const job = createVerifyBuildIntent(input());
  const payload = toVerifyBuildPayload(job, HASH('9'));
  assert.equal(payload.contractVersion, R7_CONTRACT_VERSION);
  assert.equal(payload.logicModelHash, toR7Hash(job.logicModelHash));
  assert.equal(payload.packageHash, `sha256:${job.packageHash}`);
  assert.equal(payload.manifestHash, `sha256:${job.manifestHash}`);
  assert.equal(payload.checkReportHash, toR7Hash(HASH('9')));
  assert.equal(payload.snapshotUri, job.snapshotUri);
  // The internal intent keeps raw hex; only the payload is prefixed.
  assert.match(job.logicModelHash, /^[a-f0-9]{64}$/);
});

test('the emitted payload satisfies R7 VerifyBuildPayload schema', () => {
  const job = createVerifyBuildIntent(input());
  const result = validateVerifyBuildPayload(toVerifyBuildPayload(job, HASH('9')));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('R7 schema rejects a payload missing verify-specific fields or with wrong version', () => {
  const job = createVerifyBuildIntent(input());
  const payload = toVerifyBuildPayload(job, HASH('9')) as Record<string, unknown>;
  const { packageUri: _omit, ...missing } = payload;
  assert.equal(validateVerifyBuildPayload(missing).ok, false);
  assert.equal(validateVerifyBuildPayload({ ...payload, contractVersion: '2.0.0' }).ok, false);
  assert.equal(validateVerifyBuildPayload({ ...payload, jobType: 'COMPILE_LOGIC' }).ok, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { rawHex, attemptRecordVersion, compilationExecutionFromMeta, verificationExecutionFromMeta } from '../src/r7-job-record.ts';
import { parseCompilationExecution } from '../src/compilation-result-contracts.ts';
import { parseVerificationExecution } from '../src/verification-result-contracts.ts';
import type { CompilationJobIntent } from '../src/compilation-contracts.ts';
import type { VerifyBuildJobIntent } from '../src/verify-build-contracts.ts';

const HASH = (d: string) => d.repeat(64);
const preview = { requestId: 'req-1', revision: 1, snapshotHash: HASH('a') };

test('rawHex strips R7 sha256: prefix and validates raw hex', () => {
  assert.equal(rawHex(`sha256:${HASH('b')}`), HASH('b'));
  assert.equal(rawHex(HASH('b')), HASH('b'));
  assert.equal(rawHex('sha256:not-hex'), null);
  assert.equal(rawHex(''), null);
  assert.equal(rawHex(undefined), null);
});

test('attemptRecordVersion is a stable surrogate for R7 missing recordVersion', () => {
  assert.equal(attemptRecordVersion(1), 'r7-attempt-1');
  assert.equal(attemptRecordVersion(3), 'r7-attempt-3');
});

const compileJob: CompilationJobIntent = {
  jobId: 'compile-x', jobType: 'COMPILE_LOGIC', mode: 'approved', requestId: 'req-1', revision: 1,
  requestPreview: preview, logicModelRevision: 1, logicModelHash: HASH('b'), logicModelUri: 's3://r2/snapshots/x.json',
  snapshotReference: {} as never, clinicalApprovalId: 'clin-1', checkerReportId: 'check-1', checkerInvocationId: 'inv-1',
  sourceWorkflowVersion: 5, workflowVersion: 6, idempotencyKey: 'k', handoffEventId: 'ev', createdBy: 'orch', createdAt: '2026-11-04T00:00:00.000Z', status: 'PENDING',
};

test('compilationExecutionFromMeta adapts a flat R7 SUCCEEDED JobResult into a valid execution', () => {
  const item = {
    requestId: 'req-1', status: 'SUCCEEDED', attempt: 1, leaseOwner: 'svc-compiler',
    startedAt: '2026-11-04T12:00:00.000Z', finishedAt: '2026-11-04T12:01:00.000Z',
    inputHash: HASH('1'), compileArtifactHash: HASH('2'), packageHash: `sha256:${HASH('3')}`,
    packageUri: 's3://cht-nocode-artifacts/builds/x/project.tgz', packageVersionId: 'v1',
    manifestHash: HASH('4'), manifestUri: 's3://cht-nocode-artifacts/builds/x/manifest.json', manifestVersionId: 'v2',
    compileReportUri: 's3://cht-nocode-artifacts/builds/x/report.json', compileReportHash: HASH('5'), compileReportVersionId: 'v3',
    toolVersions: { compiler: 'c1', chtConf: 'cht' },
  };
  const exec = compilationExecutionFromMeta(item, compileJob);
  assert.ok(exec, 'adapter returned an execution');
  assert.equal(exec!.status, 'SUCCEEDED');
  assert.equal(exec!.runnerActorId, 'svc-compiler'); // from leaseOwner
  assert.equal(exec!.recordVersion, 'r7-attempt-1');
  assert.equal(exec!.artifactHash, HASH('3')); // packageHash, prefix stripped
  assert.equal(exec!.compilerExitCode, 0);
  assert.equal(exec!.chtConfStatus, 'PASSED');
  // It must satisfy R2's strict parser (closed object + cross-field invariants).
  assert.ok(parseCompilationExecution(exec), 'passes parseCompilationExecution');
});

test('compilationExecutionFromMeta returns null when R7 META lacks required fields', () => {
  assert.equal(compilationExecutionFromMeta({ requestId: 'req-1', status: 'SUCCEEDED' }, compileJob), null); // no attempt/leaseOwner/startedAt
});

const verifyJob: VerifyBuildJobIntent = {
  jobId: 'verify-x', jobType: 'VERIFY_BUILD', requestId: 'req-1', revision: 1, requestPreview: preview,
  logicModelRevision: 1, logicModelHash: HASH('b'), clinicalApprovalId: 'clin-1', compileJobId: 'compile-x',
  packageHash: HASH('3'), packageUri: 's3://b/x.tgz', packageVersionId: 'v1', manifestHash: HASH('4'),
  compileArtifactHash: HASH('2'), snapshotUri: 's3://b/x.json', checkerReportId: 'check-1',
  sourceWorkflowVersion: 7, workflowVersion: 8, idempotencyKey: 'k', handoffEventId: 'ev', createdBy: 'orch', createdAt: '2026-11-04T00:00:00.000Z', status: 'PENDING',
};

test('verificationExecutionFromMeta adapts a flat R7 VERIFY_BUILD JobResult', () => {
  const item = {
    requestId: 'req-1', status: 'SUCCEEDED', attempt: 1, leaseOwner: 'svc-verifier',
    startedAt: '2026-11-04T13:00:00.000Z', finishedAt: '2026-11-04T13:05:00.000Z',
    reportUri: 's3://cht-nocode-artifacts/previews/reports/r.json', reportHash: HASH('9'), reportVersionId: 'v1',
    verificationPassed: true, coverageComplete: true, reportVersion: '2.3.0',
  };
  const exec = verificationExecutionFromMeta(item, verifyJob);
  assert.ok(exec, 'adapter returned an execution');
  assert.equal(exec!.jobType, 'VERIFY_BUILD');
  assert.equal(exec!.runnerActorId, 'svc-verifier');
  assert.equal(exec!.compileJobId, 'compile-x');
  assert.ok(parseVerificationExecution(exec), 'passes parseVerificationExecution');
});

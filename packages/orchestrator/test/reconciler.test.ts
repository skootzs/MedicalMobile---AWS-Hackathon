import test from 'node:test';
import assert from 'node:assert/strict';
import { JobCompletionReconciler } from '../src/reconciler.ts';
import type { ReconcilerDependencies } from '../src/reconciler.ts';

const HASH = (d: string) => d.repeat(64);
const compileJob = { workflowVersion: 6 };
const verifyJob = { workflowVersion: 8 };

function deps(over: Partial<ReconcilerDependencies> = {}): ReconcilerDependencies {
  return {
    store: {
      getCompilationJob: async (_r: string, jobId: string) => (jobId.startsWith('compile-') ? compileJob : null),
      getVerifyBuildJob: async (_r: string, jobId: string) => (jobId.startsWith('verify-') ? verifyJob : null),
    } as never,
    compilation: { ingest: async () => ({ status: 'ACCEPTED', reason: 'COMPILED', result: null, workflowVersion: 7, auditId: 'a', attemptAuditId: 'a' }) },
    verification: { ingest: async () => ({ status: 'ACCEPTED', reason: 'VERIFIED', result: null, workflowVersion: 9, auditId: 'a', attemptAuditId: 'a' }) },
    ...over,
  };
}

test('routes a COMPILE_LOGIC notification to the compilation ingestion service', async () => {
  let seen: unknown;
  const r = new JobCompletionReconciler(deps({ compilation: { ingest: async (c) => { seen = c; return { status: 'ACCEPTED', reason: 'COMPILED', result: null, workflowVersion: 7, auditId: 'a', attemptAuditId: 'a' }; } } }));
  const out = await r.reconcile({ requestId: 'req-1', jobId: 'compile-x', jobType: 'COMPILE_LOGIC', attempt: 1 }, 'svc-compiler');
  assert.equal(out.status, 'RECONCILED');
  assert.equal(out.jobType, 'COMPILE_LOGIC');
  assert.equal((seen as { expectedVersion: number }).expectedVersion, 6); // from the authoritative job intent, not the notification
});

test('routes a VERIFY_BUILD notification to the verification ingestion service', async () => {
  const r = new JobCompletionReconciler(deps());
  const out = await r.reconcile({ requestId: 'req-1', jobId: 'verify-x', jobType: 'VERIFY_BUILD', attempt: 1 }, 'svc-verifier');
  assert.equal(out.status, 'RECONCILED');
  assert.equal(out.jobType, 'VERIFY_BUILD');
});

test('confirms the job type from the stored intent, ignoring a wrong jobType hint', async () => {
  const r = new JobCompletionReconciler(deps());
  // Hint says VERIFY_BUILD but the jobId is a compile job: routed by the authoritative intent.
  const out = await r.reconcile({ requestId: 'req-1', jobId: 'compile-x', jobType: 'VERIFY_BUILD', attempt: 1 }, 'svc');
  assert.equal(out.jobType, 'COMPILE_LOGIC');
});

test('reports UNKNOWN_JOB when neither a compile nor verify job exists', async () => {
  const r = new JobCompletionReconciler(deps());
  const out = await r.reconcile({ requestId: 'req-1', jobId: 'other-x', attempt: 1 }, 'svc');
  assert.equal(out.status, 'UNKNOWN_JOB');
  assert.equal(out.jobType, null);
});

test('resolves requestId from the job row when the events Pipe omits it', async () => {
  let seen: unknown;
  const r = new JobCompletionReconciler(deps({
    resolveRequestId: async (jobId) => (jobId === 'compile-x' ? 'req-from-meta' : null),
    compilation: { ingest: async (c) => { seen = c; return { status: 'ACCEPTED', reason: 'COMPILED', result: null, workflowVersion: 7, auditId: 'a', attemptAuditId: 'a' }; } },
  }));
  const out = await r.reconcile({ jobId: 'compile-x', status: 'SUCCEEDED', attempt: 1 }, 'svc-compiler');
  assert.equal(out.status, 'RECONCILED');
  assert.equal((seen as { requestId: string }).requestId, 'req-from-meta');
  assert.equal((await r.reconcile({ jobId: 'missing', status: 'SUCCEEDED', attempt: 1 }, 'svc')).status, 'UNKNOWN_JOB');
});

test('rejects an invalid notification without touching any service', async () => {
  const r = new JobCompletionReconciler(deps());
  assert.equal((await r.reconcile({ requestId: '', jobId: 'compile-x', attempt: 1 }, 'svc')).status, 'REJECTED');
  assert.equal((await r.reconcile({ requestId: 'req-1', jobId: 'compile-x', attempt: 0 }, 'svc')).status, 'REJECTED');
  assert.equal((await r.reconcile({ requestId: 'req-1', jobId: 'compile-x', attempt: '2' }, 'svc')).status, 'RECONCILED');
  assert.equal((await r.reconcile({ requestId: 'req-1', jobId: 'compile-x', attempt: '01' }, 'svc')).status, 'REJECTED');
});

test('maps ingestion statuses to reconcile statuses (incl. fail-closed ones)', async () => {
  for (const [ingest, expected] of [['DUPLICATE_EVENT', 'DUPLICATE'], ['STALE_VERSION', 'STALE'], ['BLOCKED', 'BLOCKED'], ['REJECTED', 'REJECTED'], ['STORAGE_FAILURE', 'STORAGE_FAILURE']] as const) {
    const r = new JobCompletionReconciler(deps({ compilation: { ingest: async () => ({ status: ingest, reason: ingest, result: null, workflowVersion: null, auditId: null, attemptAuditId: null }) } }));
    const out = await r.reconcile({ requestId: 'req-1', jobId: 'compile-x', attempt: 1 }, 'svc');
    assert.equal(out.status, expected, `${ingest} -> ${expected}`);
  }
});

test('constructor fails closed without the required stores/services', () => {
  assert.throws(() => new JobCompletionReconciler({} as never), /Reconciler requires/);
});

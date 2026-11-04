import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftingHandoffService } from '../src/jobs.ts';
import type { DraftingHandoffCommand } from '../src/jobs.ts';
import { createDraftingIntent } from '../src/job-intents.ts';
import { RequestService } from '../src/requests.ts';
import { provisionalSnapshotValidator, canonicalizeJson } from '../src/snapshots.ts';
import { at, content, next } from './helpers/approval-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { readyWithConcern, routingCommand } from './helpers/routing-service-fixtures.ts';
import { jobFixture, readyJob, recordedJob, wrapJobStore } from './helpers/job-fixtures.ts';
import { MockDraftingWorker } from './helpers/mock-drafting-worker.ts';

test('a committed clear route atomically creates one version-bound drafting intent', async () => {
  const f = await readyJob(), r = await f.jobs.start(f.c, 'backend'); assert.equal(r.status, 'INTENT_RECORDED', r.reason);
  const s = (await f.db.getWorkflow(f.c.requestId))!; assert.equal(s.status, 'DRAFTING_LOGIC'); assert.equal(s.version, f.c.expectedVersion + 1);
  assert.equal(r.job!.sourceWorkflowVersion, f.c.expectedVersion); assert.equal(r.job!.workflowVersion, s.version); assert.equal(r.job!.routingEventId, f.c.routingEventId);
  assert.equal(r.job!.requestPreview.snapshotHash, f.c.snapshotHash); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
  assert.equal((await f.db.getReceipt(f.c.requestId, f.c.eventId))!.jobId, r.job!.jobId);
  assert.deepEqual((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.jobIntent, r.job);
  assert.equal(f.worker.attempts.length, 0); assert.equal(s.logic, null); assert.equal(s.clinicalApproval, null); assert.equal(s.releaseApproval, null);
});
test('routing and handoff are distinct: routing alone creates no job or worker delivery', async () => {
  const f = await readyJob(); assert.deepEqual(await f.db.listJobs(f.c.requestId), []); assert.equal(f.worker.attempts.length, 0); assert.equal(f.s.status, 'READY_FOR_LOGIC_PROPOSAL');
});
for (const target of ['WAITING_FOR_SCREENING', 'WAITING_FOR_PO_CONFIRMATION', 'READY_TO_ROUTE'] as const) test(`${target}/NOT_READY cannot create a drafting job`, async () => {
  const f = jobFixture(), s = await at(f.db, target), c = { ...routingCommand(s, 'blocked-handoff'), routingEventId: 'not-committed' };
  const r = await f.jobs.start(c, 'backend'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'WRONG_STATE'); assert.deepEqual(await f.db.getWorkflow(c.requestId), s); assert.deepEqual(await f.db.listJobs(c.requestId), []); assert.equal(f.worker.attempts.length, 0);
});
test('Service Designer routing cannot bypass manual clarification', async () => {
  const f = jobFixture(), s = await readyWithConcern(f.db); await f.routing.execute(routingCommand(s), 'backend');
  const current = (await f.db.getWorkflow(s.brief.requestId))!, c = { ...routingCommand(current, 'bypass-sd'), routingEventId: 'fictional-route' };
  assert.equal((await f.jobs.start(c, 'backend')).reason, 'WRONG_STATE'); assert.deepEqual(await f.db.listJobs(c.requestId), []); assert.equal(f.worker.attempts.length, 0);
});
for (const who of ['po', 'sd', 'clinic', 'release', 'ai']) test(`${who} cannot start a handoff and rejection is audited`, async () => {
  const f = await readyJob(), r = await f.jobs.start(f.c, who); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'WRONG_ROLE');
  assert.equal((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.outcome, 'REJECTED'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('unverified internal principal cannot create a job', async () => {
  const f = await readyJob(), jobs = new DraftingHandoffService({ ...f.deps, canAccessRequest: () => true });
  const r = await jobs.start(f.c, 'unknown'); assert.equal(r.reason, 'UNAUTHORIZED'); assert.equal((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.actorId, null);
});
test('denied visibility prevents reads and does not disclose existence', async () => {
  const f = await readyJob(); let reads = 0;
  const jobs = new DraftingHandoffService({ ...f.deps, canAccessRequest: () => false, store: wrapJobStore(f.db, { getWorkflow: async id => { reads++; return f.db.getWorkflow(id); } }) });
  assert.equal((await jobs.start(f.c, 'backend')).reason, 'REQUEST_NOT_FOUND'); assert.equal(reads, 0);
});
for (const change of [{ expectedVersion: 1 }, { revision: 2 }, { snapshotHash: 'e'.repeat(64) }]) test(`handoff rejects stale ${Object.keys(change)[0]}`, async () => {
  const f = await readyJob(), r = await f.jobs.start({ ...f.c, ...change }, 'backend'); assert.equal(r.status, 'STALE_VERSION'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('unknown routing receipt cannot authorize handoff', async () => {
  const f = await readyJob(); assert.equal((await f.jobs.start({ ...f.c, routingEventId: 'not-a-route' }, 'backend')).reason, 'CURRENT_ROUTING_RECEIPT_REQUIRED');
});
for (const kind of ['missing', 'stale', 'wrong-route', 'wrong-request', 'wrong-fingerprint'] as const) test(`${kind} routing evidence blocks handoff`, async () => {
  const f = await readyJob(), store = wrapJobStore(f.db, { getReceipt: async (id, event) => {
    const r = await f.db.getReceipt(id, event); if (event !== f.c.routingEventId || !r) return r;
    if (kind === 'missing') return null;
    if (kind === 'stale') return { ...r, workflowVersion: r.workflowVersion - 1 };
    if (kind === 'wrong-route') return { ...r, routing: { ...r.routing!, route: 'NEEDS_SD_REVIEW' } };
    if (kind === 'wrong-request') return { ...r, request: { ...r.request, snapshotHash: 'f'.repeat(64) } };
    return { ...r, fingerprint: 'not-accepted' };
  } });
  const jobs = new DraftingHandoffService({ ...f.deps, store }); assert.equal((await jobs.start(f.c, 'backend')).reason, 'CURRENT_ROUTING_RECEIPT_REQUIRED'); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('missing preview snapshot blocks handoff before worker execution', async () => {
  const f = await readyJob(), jobs = new DraftingHandoffService({ ...f.deps, store: wrapJobStore(f.db, { getSnapshot: async () => null }) });
  assert.equal((await jobs.start(f.c, 'backend')).reason, 'SNAPSHOT_REQUIRED'); assert.equal(f.worker.attempts.length, 0);
});
test('identical handoff retries acknowledge one logical job, including a new service instance', async () => {
  const f = await recordedJob(), jobs = new DraftingHandoffService(f.deps), r = await jobs.start(f.c, 'backend');
  assert.equal(r.status, 'DUPLICATE_EVENT'); assert.equal(r.job!.jobId, f.job.jobId); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1); assert.equal(f.worker.attempts.length, 0);
});
for (const change of [{ routingEventId: 'other-route' }, { revision: 2 }, { expectedVersion: 6 }, { snapshotHash: 'f'.repeat(64) }]) test(`accepted handoff ID reuse with changed ${Object.keys(change)[0]} conflicts`, async () => {
  const f = await recordedJob(); assert.equal((await f.jobs.start({ ...f.c, ...change }, 'backend')).reason, 'EVENT_ID_REUSED'); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('distinct concurrent handoffs cannot create two jobs for one workflow version', async () => {
  const f = await readyJob(), results = await Promise.all(['one', 'two'].map(eventId => f.jobs.start({ ...f.c, eventId }, 'backend')));
  assert.equal(results.filter(r => r.status === 'INTENT_RECORDED').length, 1); assert.equal(results.filter(r => r.status === 'STALE_VERSION').length, 1); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('concurrent identical handoffs are idempotent', async () => {
  const f = await readyJob(), results = await Promise.all([f.jobs.start(f.c, 'backend'), f.jobs.start(f.c, 'backend')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['DUPLICATE_EVENT', 'INTENT_RECORDED']); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('concurrent commit between receipt/state reads returns an identical retry', async () => {
  const f = await readyJob(); let reads = 0;
  const store = wrapJobStore(f.db, { getReceipt: async (id, event) => { const r = await f.db.getReceipt(id, event); if (++reads === 1) assert.equal((await f.jobs.start(f.c, 'backend')).status, 'INTENT_RECORDED'); return r; } });
  assert.equal((await new DraftingHandoffService({ ...f.deps, store }).start(f.c, 'backend')).status, 'DUPLICATE_EVENT');
});
test('failed atomic creation leaves no job, transition, receipt or partial audit', async () => {
  let fail = false; const f = await readyJob(jobFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('fictional commit failure'); } } }));
  const audits = await f.db.listAudit(f.c.requestId); fail = true; assert.equal((await f.jobs.start(f.c, 'backend')).status, 'STORAGE_FAILURE'); fail = false;
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s); assert.deepEqual(await f.db.listJobs(f.c.requestId), []); assert.deepEqual(await f.db.listAudit(f.c.requestId), audits); assert.equal(await f.db.getReceipt(f.c.requestId, f.c.eventId), null);
  assert.equal((await f.jobs.start(f.c, 'backend')).status, 'INTENT_RECORDED');
});
test('direct internal START cannot advance without an atomically recorded intent', async () => {
  const f = await readyJob(), step = next(f.s); assert.equal((await f.db.apply(step.cmd, step.who)).outcome, 'ACCEPTED');
  const jobs = await f.db.listJobs(f.c.requestId); assert.equal(jobs.length, 1); assert.equal((await f.db.getReceipt(f.c.requestId, step.cmd.event.eventId))!.jobId, jobs[0].jobId);
});
test('tampered supplied job metadata is rejected inside atomic storage', async () => {
  const f = await readyJob(), job = createDraftingIntent(f.c, f.c.expectedVersion, f.c.routingEventId, f.c.eventId);
  const r = await f.db.apply({ requestId: f.c.requestId, attemptId: 'bad-job', event: { type: 'START_LOGIC_PROPOSAL', eventId: f.c.eventId, expectedVersion: f.c.expectedVersion,
    request: { requestId: f.c.requestId, revision: f.c.revision, snapshotHash: f.c.snapshotHash } }, jobIntent: { ...job, workflowVersion: 999 } }, 'backend');
  assert.equal(r.reason, 'INVALID_JOB_INTENT'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('job reads are detached and preserve immutable snapshot identity/history', async () => {
  const f = await recordedJob(), job = (await f.db.getJob(f.c.requestId, f.job.jobId))!;
  (job.requestPreview as { snapshotHash: string }).snapshotHash = 'changed'; assert.equal((await f.db.getJob(f.c.requestId, f.job.jobId))!.requestPreview.snapshotHash, f.c.snapshotHash);
  const original = await f.db.listSnapshots(f.c.requestId); assert.equal(original[0].snapshotHash, f.job.requestPreview.snapshotHash);
});
test('revision invalidates delivery eligibility but preserves the immutable historical job', async () => {
  const f = await recordedJob(), s = (await f.db.getWorkflow(f.c.requestId))!;
  const requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  await requests.revise({ requestId: f.c.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, expectedVersion: s.version, eventId: 'new-preview', content: content(2) }, 'po');
  const before = await f.db.getWorkflow(f.c.requestId); assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'STALE_VERSION'); assert.equal(f.worker.attempts.length, 0);
  assert.equal((await f.jobs.start(f.c, 'backend')).status, 'DUPLICATE_EVENT'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), before); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('superseded preview cannot start a new handoff with a new event ID', async () => {
  const f = await readyJob(), requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  await requests.revise({ requestId: f.c.requestId, revision: f.s.brief.revision, snapshotHash: f.s.brief.snapshotHash, expectedVersion: f.s.version, eventId: 'new-preview', content: content(2) }, 'po');
  assert.equal((await f.jobs.start(f.c, 'backend')).status, 'STALE_VERSION'); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('explicit delivery reports acceptance but never completion or approval', async () => {
  const f = await recordedJob(), state = await f.db.getWorkflow(f.c.requestId), r = await f.jobs.deliver(f.delivery, 'backend');
  assert.equal(r.status, 'DELIVERED'); assert.equal(r.workerOutcome, 'ACCEPTED'); assert.equal(f.worker.logicalJobs, 1); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), state);
  assert.equal('completed' in r, false); assert.equal(state!.logic, null); assert.equal(state!.clinicalApproval, null); assert.equal(state!.releaseApproval, null);
  const audit = (await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!; assert.equal(audit.eventType, 'DELIVER_DRAFTING_JOB'); assert.equal(audit.from, audit.to); assert.equal(audit.jobDelivery!.outcome, 'ACCEPTED');
});
for (const [outcome, expected] of [['UNAVAILABLE', 'TEMPORARY_UNAVAILABLE'], ['FAILED', 'DISPATCH_FAILED'], ['THROW', 'DISPATCH_FAILED']] as const) test(`${outcome} worker result is not completion and triggers no automatic retry`, async () => {
  const worker = new MockDraftingWorker([outcome]), f = await recordedJob(jobFixture({}, { worker })), state = await f.db.getWorkflow(f.c.requestId);
  const r = await f.jobs.deliver(f.delivery, 'backend'); assert.equal(r.status, expected); assert.equal(worker.attempts.length, 1); assert.equal(worker.logicalJobs, 0); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), state);
  assert.equal((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.outcome, 'REJECTED');
});
test('manual retry after unavailable delivery reuses the same job and idempotency key', async () => {
  const worker = new MockDraftingWorker(['UNAVAILABLE', 'ACCEPTED']), f = await recordedJob(jobFixture({}, { worker }));
  assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'TEMPORARY_UNAVAILABLE'); assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'DELIVERED');
  assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'DUPLICATE_DELIVERY'); assert.equal(worker.logicalJobs, 1);
  assert.equal(new Set(worker.attempts.map(j => j.jobId)).size, 1); assert.equal(new Set(worker.attempts.map(j => j.idempotencyKey)).size, 1); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('concurrent at-least-once deliveries create one logical mock-worker job', async () => {
  const f = await recordedJob(), results = await Promise.all([f.jobs.deliver(f.delivery, 'backend'), f.jobs.deliver(f.delivery, 'backend')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['DELIVERED', 'DUPLICATE_DELIVERY']); assert.equal(f.worker.logicalJobs, 1); assert.equal((await f.db.getWorkflow(f.c.requestId))!.version, f.job.workflowVersion);
});
test('missing worker adapter cannot be mistaken for delivery', async () => {
  const f = await recordedJob(), jobs = new DraftingHandoffService({ ...f.deps, worker: undefined });
  const r = await jobs.deliver(f.delivery, 'backend'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'WORKER_NOT_CONFIGURED'); assert.equal(r.workerOutcome, 'NOT_ATTEMPTED');
});
for (const who of ['po', 'sd', 'clinic', 'release', 'ai']) test(`${who} delivery is rejected and audited before worker execution`, async () => {
  const f = await recordedJob(), r = await f.jobs.deliver(f.delivery, who); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'WRONG_ROLE'); assert.equal(f.worker.attempts.length, 0);
  assert.equal((await f.db.listAudit(f.c.requestId)).find(a => a.auditId === r.auditId)!.outcome, 'REJECTED');
});
test('stale delivery version cannot invoke the worker', async () => {
  const f = await recordedJob(); assert.equal((await f.jobs.deliver({ ...f.delivery, expectedVersion: 1 }, 'backend')).status, 'STALE_VERSION'); assert.equal(f.worker.attempts.length, 0);
});
test('missing job cannot invoke the worker or advance workflow', async () => {
  const f = await recordedJob(); const r = await f.jobs.deliver({ ...f.delivery, jobId: 'not-a-job' }, 'backend'); assert.equal(r.reason, 'JOB_NOT_FOUND'); assert.equal(f.worker.attempts.length, 0);
});
test('malformed worker acknowledgement fails closed', async () => {
  const f = await recordedJob(jobFixture({}, { worker: { deliver: async () => ({ outcome: 'ACCEPTED', jobId: 'other-job', idempotencyKey: 'wrong' }) } }));
  const r = await f.jobs.deliver(f.delivery, 'backend'); assert.equal(r.status, 'DISPATCH_FAILED'); assert.equal(r.reason, 'WORKER_PROTOCOL_ERROR');
});
test('worker acceptance followed by audit-storage failure is explicitly ambiguous and retry-safe', async () => {
  let fail = false; const f = await recordedJob(jobFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('fictional audit failure'); } } }));
  const before = await f.db.listAudit(f.c.requestId); fail = true; const r = await f.jobs.deliver(f.delivery, 'backend'); fail = false;
  assert.equal(r.status, 'STORAGE_FAILURE'); assert.equal(r.workerOutcome, 'ACCEPTED'); assert.equal(f.worker.logicalJobs, 1); assert.deepEqual(await f.db.listAudit(f.c.requestId), before);
  assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'DUPLICATE_DELIVERY'); assert.equal(f.worker.logicalJobs, 1);
});
for (const extra of [{ actorId: 'backend' }, { roles: ['ORCHESTRATOR'] }, { trusted: true }, { jobId: 'client-job' }, { jobType: 'CLINICAL_APPROVAL' }]) test(`start rejects unexpected ${Object.keys(extra)[0]}`, async () => {
  const f = await readyJob(); assert.equal((await f.jobs.start({ ...f.c, ...extra }, 'backend')).reason, 'INVALID_COMMAND');
});
test('delivery rejects browser role/identity authority fields', async () => {
  const f = await recordedJob(); assert.equal((await f.jobs.deliver({ ...f.delivery, roles: ['ORCHESTRATOR'] } as never, 'backend')).reason, 'INVALID_COMMAND'); assert.equal(f.worker.attempts.length, 0);
});
test('unsupported input values fail closed without creating jobs', async () => {
  const f = await readyJob(); for (const input of [null, [], {}, { ...f.c, expectedVersion: 0 }, { ...f.c, revision: 1.5 }, { ...f.c, snapshotHash: 'bad' }]) assert.equal((await f.jobs.start(input as DraftingHandoffCommand, 'backend')).reason, 'INVALID_COMMAND');
});
test('intent creation is immutable, deterministic and does not create clinical content', () => {
  const request = { requestId: 'fictional-001', revision: 1, snapshotHash: 'a'.repeat(64) };
  const a = createDraftingIntent(request, 4, 'route-event', 'handoff-a'), b = createDraftingIntent(request, 4, 'route-event', 'handoff-b');
  assert.equal(a.jobId, b.jobId); assert.equal(a.idempotencyKey, b.idempotencyKey); assert.equal(Object.isFrozen(a.requestPreview), true); assert.equal(Object.isFrozen(a), true);
  assert.equal('logicModel' in a, false); assert.equal('content' in a, false); assert.notEqual(a.jobId, createDraftingIntent({ ...request, revision: 2 }, 4, 'route-event', 'handoff-a').jobId);
});
test('missing trusted boundaries are never replaced with an allow default', () => { assert.throws(() => new DraftingHandoffService({} as never)); });

test('historical handoff receipt without its required job cannot report an idempotent success', async () => {
  const f = await recordedJob(), jobs = new DraftingHandoffService({ ...f.deps, store: wrapJobStore(f.db, { getJob: async () => null }) });
  assert.equal((await jobs.start(f.c, 'backend')).status, 'STORAGE_FAILURE');
});
for (const method of ['getWorkflow', 'getReceipt', 'getSnapshot', 'getJob'] as const) test(`${method} failure does not falsely report a recorded handoff`, async () => {
  const f = await readyJob(), jobs = new DraftingHandoffService({ ...f.deps, store: wrapJobStore(f.db, { [method]: async () => { throw Error('fictional private storage error'); } }) });
  assert.equal((await jobs.start(f.c, 'backend')).status, 'STORAGE_FAILURE');
});
test('wrong actor identity at commit cannot create the job', async () => {
  let changed = false; const f = await readyJob(jobFixture({ resolveActor: p => p === 'backend' && changed ? { id: 'other-internal-actor', roles: ['ORCHESTRATOR'] } : resolveReviewActor(p) }));
  changed = true; assert.equal((await f.jobs.start(f.c, 'backend')).reason, 'IDENTITY_CHANGED'); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('lost ORCHESTRATOR role at commit cannot create the job', async () => {
  let changed = false; const f = await readyJob(jobFixture({ resolveActor: p => p === 'backend' && changed ? { id: 'fictional-backend', roles: ['PO'] } : resolveReviewActor(p) }));
  changed = true; assert.equal((await f.jobs.start(f.c, 'backend')).reason, 'WRONG_ROLE'); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('request visibility revoked during start prevents any handoff', async () => {
  const f = await readyJob(); let reads = 0;
  const jobs = new DraftingHandoffService({ ...f.deps, canAccessRequest: () => ++reads === 1 }); assert.equal((await jobs.start(f.c, 'backend')).reason, 'REQUEST_NOT_FOUND'); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('configurable internal-actor policy can restrict handoff creation', async () => {
  const f = await readyJob(), jobs = new DraftingHandoffService({ ...f.deps, authorizeActor: () => false });
  const r = await jobs.start(f.c, 'backend'); assert.equal(r.reason, 'WRONG_ROLE'); assert.ok(r.auditId); assert.deepEqual(await f.db.listJobs(f.c.requestId), []);
});
test('internal-actor policy cannot grant a prohibited PO role', async () => {
  const f = await readyJob(), jobs = new DraftingHandoffService({ ...f.deps, authorizeActor: () => true }); assert.equal((await jobs.start(f.c, 'po')).reason, 'WRONG_ROLE');
});
test('request revision during worker delivery rejects the audit as current-job evidence but preserves actual worker outcome', async () => {
  const f = await recordedJob(), requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  const jobs = new DraftingHandoffService({ ...f.deps, worker: { deliver: async intent => {
    const s = (await f.db.getWorkflow(f.c.requestId))!;
    await requests.revise({ requestId: f.c.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, expectedVersion: s.version, eventId: 'during-delivery', content: content(2) }, 'po');
    return { outcome: 'ACCEPTED', jobId: intent.jobId, idempotencyKey: intent.idempotencyKey };
  } } });
  const r = await jobs.deliver(f.delivery, 'backend'); assert.equal(r.status, 'STALE_VERSION'); assert.equal(r.workerOutcome, 'ACCEPTED');
  assert.equal((await f.db.getWorkflow(f.c.requestId))!.status, 'WAITING_FOR_SCREENING'); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('role revocation detected just before delivery prevents the worker call', async () => {
  const f = await recordedJob(); let calls = 0;
  const jobs = new DraftingHandoffService({ ...f.deps, resolveActor: p => ++calls === 1 ? resolveReviewActor(p) : { id: 'fictional-backend', roles: ['PO'] } });
  assert.equal((await jobs.deliver(f.delivery, 'backend')).reason, 'WRONG_ROLE'); assert.equal(f.worker.attempts.length, 0);
});
test('unknown delivery principal is rejected with a transport audit and no worker call', async () => {
  const f = await recordedJob(), jobs = new DraftingHandoffService({ ...f.deps, canAccessRequest: () => true });
  const r = await jobs.deliver(f.delivery, 'unknown'); assert.equal(r.reason, 'UNAUTHORIZED'); assert.ok(r.auditId); assert.equal(f.worker.attempts.length, 0);
});
test('denied delivery visibility does not read private job metadata', async () => {
  const f = await recordedJob(); let reads = 0;
  const jobs = new DraftingHandoffService({ ...f.deps, canAccessRequest: () => false, store: wrapJobStore(f.db, { getJob: async (id, jobId) => { reads++; return f.db.getJob(id, jobId); } }) });
  assert.equal((await jobs.deliver(f.delivery, 'backend')).reason, 'REQUEST_NOT_FOUND'); assert.equal(reads, 0); assert.equal(f.worker.attempts.length, 0);
});
test('delivery audit attempt IDs are idempotent and cannot be overwritten', async () => {
  const f = await recordedJob(), attempt = { ...f.delivery, attemptId: 'same-delivery-attempt', outcome: 'ACCEPTED' as const };
  const a = await f.db.recordJobDelivery(attempt, 'backend'), before = await f.db.listAudit(f.c.requestId), b = await f.db.recordJobDelivery(attempt, 'backend');
  assert.equal(b.replayed, true); assert.equal(a.auditId, b.auditId); assert.deepEqual(await f.db.listAudit(f.c.requestId), before);
  await assert.rejects(f.db.recordJobDelivery({ ...attempt, outcome: 'FAILED' }, 'backend'), { code: 'ATTEMPT_ID_REUSED' });
});
test('forged transport audit roles/outcomes fail closed inside the store', async () => {
  const f = await recordedJob(); const attempt = { ...f.delivery, attemptId: 'bad-transport', outcome: 'ACCEPTED' as const, actorId: 'backend' };
  await assert.rejects(f.db.recordJobDelivery(attempt, 'backend'), { code: 'INVALID_COMMAND' });
  await assert.rejects(f.db.recordJobDelivery({ ...f.delivery, attemptId: 'bad-completion', outcome: 'COMPLETED' } as never, 'backend'), { code: 'INVALID_COMMAND' });
});
test('a job cannot be attached to an unrelated workflow transition', async () => {
  const f = await readyJob(), job = createDraftingIntent(f.c, f.c.expectedVersion, f.c.routingEventId, f.c.eventId);
  const r = await f.db.apply({ requestId: f.c.requestId, attemptId: 'unrelated-intent', event: { type: 'FAIL', eventId: 'cannot-attach', expectedVersion: f.c.expectedVersion,
    request: { requestId: f.c.requestId, revision: f.c.revision, snapshotHash: f.c.snapshotHash }, note: 'Fictional invalid attempt' }, jobIntent: job }, 'backend');
  assert.equal(r.reason, 'UNRELATED_JOB_INTENT'); assert.deepEqual(await f.db.listJobs(f.c.requestId), []); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
test('worker acknowledgement loss can be retried with the same logical job', async () => {
  let accepted = false; const f = await recordedJob(jobFixture({}, { worker: { deliver: async intent => {
    if (!accepted) { accepted = true; throw Error('Fictional acknowledgement lost after acceptance'); }
    return { outcome: 'DUPLICATE', jobId: intent.jobId, idempotencyKey: intent.idempotencyKey };
  } } }));
  assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'DISPATCH_FAILED'); assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'DUPLICATE_DELIVERY'); assert.equal((await f.db.listJobs(f.c.requestId)).length, 1);
});
test('delivery after downstream completion cannot rerun the old drafting job', async () => {
  const f = await recordedJob(), s = (await f.db.getWorkflow(f.c.requestId))!, step = next(s); assert.equal((await f.db.apply(step.cmd, step.who)).outcome, 'ACCEPTED');
  assert.equal((await f.jobs.deliver(f.delivery, 'backend')).status, 'STALE_VERSION'); assert.equal(f.worker.attempts.length, 0);
});
test('worker transport success cannot bypass clinician or release approval', async () => {
  const f = await recordedJob(); await f.jobs.deliver(f.delivery, 'backend'); const s = (await f.db.getWorkflow(f.c.requestId))!;
  for (const type of ['START_COMPILATION', 'MAKE_DOWNLOAD_AVAILABLE'] as const) {
    const r = await f.db.apply({ requestId: f.c.requestId, attemptId: `bypass-${type}`, event: {
      ...(type === 'START_COMPILATION' ? { type, compilationId: 'fake-compile' } : { type }), eventId: `bypass-${type}`, expectedVersion: s.version, request: { ...f.job.requestPreview },
    } }, 'backend'); assert.equal(r.outcome, 'REJECTED');
  }
  assert.deepEqual(await f.db.getWorkflow(f.c.requestId), s);
});
test('job identity factory is limited to snapshot identity, not unrelated command fields', () => {
  const ref = { requestId: 'fictional-001', revision: 1, snapshotHash: 'a'.repeat(64) };
  const a = createDraftingIntent(ref, 4, 'route', 'handoff'), b = createDraftingIntent({ ...ref, extra: 'ignored command metadata' } as typeof ref, 4, 'route', 'handoff');
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
});

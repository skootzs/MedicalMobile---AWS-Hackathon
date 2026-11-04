import assert from 'node:assert/strict';
import test from 'node:test';
import { RoutingService } from '../src/routing-service.ts';
import type { RoutingCommand } from '../src/routing-service.ts';
import { RequestService } from '../src/requests.ts';
import { provisionalSnapshotValidator, canonicalizeJson } from '../src/snapshots.ts';
import { at, content } from './helpers/approval-fixtures.ts';
import { resolveReviewActor } from './helpers/review-fixtures.ts';
import { wrapStore } from './helpers/api-fixtures.ts';
import { routingFixture, routingCommand, readyWithConcern } from './helpers/routing-service-fixtures.ts';

async function ready() { const f = routingFixture(), s = await at(f.db, 'READY_TO_ROUTE'); return { ...f, s, c: routingCommand(s) }; }

test('confirmed clear request commits existing logic-proposal-ready transition and no downstream work', async () => {
  const f = await ready(), r = await f.routing.execute(f.c, 'backend'); assert.equal(r.status, 'SUCCESS', r.reason); assert.equal(r.routing!.route, 'READY_FOR_BEDROCK_REVIEW');
  const s = (await f.db.getWorkflow('fictional-001'))!; assert.equal(s.status, 'READY_FOR_LOGIC_PROPOSAL'); assert.equal(s.version, f.s.version + 1);
  assert.equal(s.logic, null); assert.equal(s.clinicalApproval, null); assert.equal(s.compilationId, null); assert.equal(s.releaseApproval, null);
});
test('unresolved current concern commits SD escalation discoverable through existing queue', async () => {
  const f = routingFixture(), s = await readyWithConcern(f.db), r = await f.routing.execute(routingCommand(s), 'backend');
  assert.equal(r.status, 'SUCCESS'); assert.equal(r.routing!.route, 'NEEDS_SD_REVIEW'); assert.equal((await f.db.getWorkflow('fictional-001'))!.status, 'NEEDS_SD_REVIEW');
  const queue = await f.reviews.queue('SERVICE_DESIGNER', 'sd'); if (queue.status !== 'SUCCESS') throw Error('fixture'); assert.equal(queue.items.length, 1);
  assert.equal('assignee' in queue.items[0], false); assert.equal(r.routing!.clinicalApprovalRequired, true);
});
for (const status of ['WAITING_FOR_SCREENING', 'WAITING_FOR_PO_CONFIRMATION'] as const) test(`${status} remains NOT_READY on repeated routing attempts`, async () => {
  const f = routingFixture(), s = await at(f.db, status), c = routingCommand(s);
  for (let i = 0; i < 2; i++) { const r = await f.routing.execute(c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.equal(r.routing!.route, 'NOT_READY'); assert.ok(r.routing!.reasons.length > 0); }
  assert.deepEqual(await f.db.getWorkflow('fictional-001'), s); assert.equal(await f.db.getReceipt('fictional-001', c.eventId), null);
  const queue = await f.reviews.queue('SERVICE_DESIGNER', 'sd'); if (queue.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(queue.items, []);
});
for (const who of ['po', 'sd', 'clinic', 'release', 'ai']) test(`unsupported ${who} role cannot route`, async () => {
  const f = await ready(), r = await f.routing.execute(f.c, who); assert.equal(r.reason, 'WRONG_ROLE'); assert.deepEqual(await f.db.getWorkflow('fictional-001'), f.s);
});
test('unverified identity cannot route even when a faulty visibility adapter allows access', async () => {
  const f = await ready(), service = new RoutingService({ ...f.deps, canAccessRequest: () => true }); assert.equal((await service.execute(f.c, 'unknown')).reason, 'UNAUTHORIZED');
});
test('request access is checked before private workflow and evidence reads', async () => {
  const f = await ready(); let reads = 0;
  const service = new RoutingService({ ...f.deps, canAccessRequest: () => false, store: wrapStore(f.db, { getWorkflow: async id => { reads++; return f.db.getWorkflow(id); } }) });
  assert.equal((await service.execute(f.c, 'backend')).reason, 'REQUEST_NOT_FOUND'); assert.equal(reads, 0);
});
test('configurable policy may restrict the default internal ORCHESTRATOR actor', async () => {
  const f = await ready(), service = new RoutingService({ ...f.deps, authorizeActor: () => false }); assert.equal((await service.execute(f.c, 'backend')).reason, 'WRONG_ROLE');
});
test('configurable policy cannot elevate a PO past the existing workflow role guard', async () => {
  const f = await ready(), service = new RoutingService({ ...f.deps, authorizeActor: () => true }); assert.equal((await service.execute(f.c, 'po')).reason, 'WRONG_ROLE');
});
for (const kind of ['SCREENING_COMPLETED', 'PO_DECISION'] as const) test(`missing accepted ${kind} record blocks despite apparently valid state`, async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).filter(r => r.kind !== kind) }) });
  const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.ok(r.routing!.reasons.some(r => r.code === 'CONFLICTING_EVIDENCE')); assert.deepEqual(await f.db.getWorkflow('fictional-001'), f.s);
});
for (const kind of ['SCREENING_COMPLETED', 'PO_DECISION'] as const) test(`conflicting duplicate ${kind} records block routing`, async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { listEvidence: async id => { const e = await f.db.listEvidence(id); return [...e, ...e.filter(r => r.kind === kind)]; } }) });
  assert.equal((await service.execute(f.c, 'backend')).status, 'NOT_READY');
});
for (const status of ['PENDING', 'FAILED'] as const) test(`${status} screening flags cannot establish routing eligibility`, async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s ? { ...s, screening: { ...s.screening!, status } } : null; } }) });
  const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.ok(r.routing!.reasons.some(r => r.code === (status === 'PENDING' ? 'SCREENING_INCOMPLETE' : 'SCREENING_FAILED')));
});
test('unassessed screening area blocks instead of creating an SD task', async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); if (s) s.screening!.checks.feasibility = { outcome: 'NOT_ASSESSED', reasons: [] }; return s; } }) });
  const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.equal((await f.db.getWorkflow('fictional-001'))!.routing, null);
});
for (const field of ['screening', 'confirmation'] as const) test(`stale ${field} hash blocks routing`, async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s ? { ...s, [field]: { ...s[field], snapshotHash: 'e'.repeat(64) } } : null; } }) });
  const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.ok(r.routing!.reasons.some(r => r.code === 'STALE_EVIDENCE'));
});
test('mismatched screening and confirmation IDs block routing', async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s ? { ...s, confirmation: { ...s.confirmation!, screeningId: 'other-screen' } } : null; } }) });
  assert.equal((await service.execute(f.c, 'backend')).status, 'NOT_READY');
});
test('PO correction request does not authorize routing', async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s ? { ...s, confirmation: { ...s.confirmation!, decision: 'REVISION_REQUESTED' } } : null; } }) });
  const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.ok(r.routing!.reasons.some(r => r.code === 'PO_NOT_CONFIRMED'));
});
for (const missing of [true, false]) test(`${missing ? 'missing' : 'mismatched'} immutable preview blocks routing`, async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getSnapshot: async key => { const s = await f.db.getSnapshot(key); return missing ? null : s ? { ...s, snapshotHash: 'e'.repeat(64) } : null; } }) });
  const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'NOT_READY'); assert.ok(r.routing!.reasons.some(r => r.field === 'preview'));
});
test('preview content mismatch cannot be ignored when hashes are claimed to match', async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getSnapshot: async key => { const s = await f.db.getSnapshot(key); return s ? { ...s, content: { ...s.content, title: 'Different fictional content' } } : null; } }) });
  assert.equal((await service.execute(f.c, 'backend')).status, 'NOT_READY');
});
for (const changes of [{ expectedVersion: 1 }, { revision: 2 }, { snapshotHash: 'e'.repeat(64) }]) test(`stale command ${Object.keys(changes)[0]} rejects without advancement`, async () => {
  const f = await ready(), r = await f.routing.execute({ ...f.c, ...changes }, 'backend'); assert.equal(r.status, 'STALE_VERSION'); assert.equal(r.routing, null); assert.deepEqual(await f.db.getWorkflow('fictional-001'), f.s);
});
test('distinct concurrent commands cannot consume the same workflow version twice', async () => {
  const f = await ready(), results = await Promise.all(['one', 'two'].map(eventId => f.routing.execute({ ...f.c, eventId }, 'backend')));
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 1); assert.equal(results.filter(r => r.status === 'STALE_VERSION').length, 1); assert.equal((await f.db.getWorkflow('fictional-001'))!.version, f.s.version + 1);
});
test('identical concurrent commands are idempotent', async () => {
  const f = await ready(), results = await Promise.all([f.routing.execute(f.c, 'backend'), f.routing.execute(f.c, 'backend')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['DUPLICATE_EVENT', 'SUCCESS']); assert.equal((await f.db.getWorkflow('fictional-001'))!.version, f.s.version + 1);
});
test('duplicate retries return original routing and do not repeat the transition', async () => {
  const f = await ready(), first = await f.routing.execute(f.c, 'backend'), second = await f.routing.execute(f.c, 'backend');
  assert.equal(second.status, 'DUPLICATE_EVENT'); assert.deepEqual(second.routing, first.routing);
  assert.equal((await f.db.listAudit('fictional-001')).filter(a => a.eventType === 'APPLY_ROUTING' && a.outcome === 'ACCEPTED').length, 1);
});
for (const changes of [{ expectedVersion: 5 }, { revision: 2 }, { snapshotHash: 'f'.repeat(64) }]) test(`accepted event reuse with changed ${Object.keys(changes)[0]} conflicts`, async () => {
  const f = await ready(); await f.routing.execute(f.c, 'backend'); const before = await f.db.getWorkflow('fictional-001');
  assert.equal((await f.routing.execute({ ...f.c, ...changes }, 'backend')).reason, 'EVENT_ID_REUSED'); assert.deepEqual(await f.db.getWorkflow('fictional-001'), before);
});
test('later revisions invalidate routing eligibility and accepted retry never restores it', async () => {
  const f = await ready(), first = await f.routing.execute(f.c, 'backend'), routed = (await f.db.getWorkflow('fictional-001'))!;
  const requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  assert.equal((await requests.revise({ requestId: f.c.requestId, revision: routed.brief.revision, snapshotHash: routed.brief.snapshotHash, expectedVersion: routed.version, eventId: 'new-preview', content: content(2) }, 'po')).status, 'SUCCESS');
  const revised = (await f.db.getWorkflow('fictional-001'))!; assert.equal(revised.routing, null);
  const retry = await f.routing.execute(f.c, 'backend'); assert.equal(retry.status, 'DUPLICATE_EVENT'); assert.deepEqual(retry.routing, first.routing); assert.deepEqual(await f.db.getWorkflow('fictional-001'), revised);
  assert.equal((await f.routing.execute({ ...f.c, eventId: 'late-routing' }, 'backend')).status, 'STALE_VERSION');
  assert.equal((await f.routing.execute(routingCommand(revised, 'route-new-preview'), 'backend')).status, 'NOT_READY');
});
test('accepted receipt and audit retain full routing reasons and exact evidence refs', async () => {
  const f = routingFixture(), s = await readyWithConcern(f.db), c = routingCommand(s), r = await f.routing.execute(c, 'backend');
  const receipt = await f.db.getReceipt(c.requestId, c.eventId), audit = (await f.db.listAudit(c.requestId)).find(a => a.auditId === r.auditId)!;
  assert.deepEqual(receipt!.routing, r.routing); assert.deepEqual(audit.routing, r.routing);
  assert.equal(audit.routing!.screeningId, s.screening!.screeningId); assert.equal(audit.routing!.confirmationId, s.confirmation!.confirmationId);
  assert.equal(audit.routing!.snapshotHash, s.brief.snapshotHash); assert.ok(audit.routing!.reasons.some(r => r.field === 'screening.checks.clinicalSafety'));
  receipt!.routing!.reasons[0].message = 'changed returned copy'; assert.notEqual((await f.db.getReceipt(c.requestId, c.eventId))!.routing!.reasons[0].message, 'changed returned copy');
});
test('failed routing transaction leaves no partial decision, receipt or audit', async () => {
  let fail = false; const f = routingFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('fictional storage failure'); } } }); const s = await at(f.db, 'READY_TO_ROUTE'), c = routingCommand(s);
  const before = { audit: await f.db.listAudit(c.requestId), evidence: await f.db.listEvidence(c.requestId), snapshots: await f.db.listSnapshots(c.requestId) };
  fail = true; assert.equal((await f.routing.execute(c, 'backend')).status, 'STORAGE_FAILURE'); fail = false;
  assert.deepEqual(await f.db.getWorkflow(c.requestId), s); assert.deepEqual(await f.db.listAudit(c.requestId), before.audit); assert.deepEqual(await f.db.listEvidence(c.requestId), before.evidence); assert.deepEqual(await f.db.listSnapshots(c.requestId), before.snapshots); assert.equal(await f.db.getReceipt(c.requestId, c.eventId), null);
  assert.equal((await f.routing.execute(c, 'backend')).status, 'SUCCESS');
});
for (const method of ['getWorkflow', 'getReceipt', 'getSnapshot', 'listEvidence'] as const) test(`${method} storage failure cannot produce success`, async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { [method]: async () => { throw Error('private failure'); } }) });
  assert.equal((await service.execute(f.c, 'backend')).status, 'STORAGE_FAILURE'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
for (const extra of [{ roles: ['ORCHESTRATOR'] }, { actorId: 'backend' }, { trusted: true }, { screeningStatus: 'ASSESSED' }, { result: { route: 'READY_FOR_BEDROCK_REVIEW' } }, { screeningId: 'supplied' }]) test(`service rejects extra ${Object.keys(extra)[0]}`, async () => {
  const f = await ready(); assert.equal((await f.routing.execute({ ...f.c, ...extra }, 'backend')).reason, 'INVALID_COMMAND');
});
test('invalid command JSON and versions fail closed', async () => {
  const f = await ready(); for (const input of [null, [], {}, { ...f.c, expectedVersion: 0 }, { ...f.c, expectedVersion: 1.5 }, { ...f.c, snapshotHash: 'not-a-hash' }]) assert.equal((await f.routing.execute(input as RoutingCommand, 'backend')).reason, 'INVALID_COMMAND');
});
test('routing requires explicit trusted boundaries', () => { assert.throws(() => new RoutingService({} as never)); });
test('authorization revocation while loading records prevents commit', async () => {
  const f = await ready(); let calls = 0; const service = new RoutingService({ ...f.deps, canAccessRequest: () => ++calls === 1 });
  assert.equal((await service.execute(f.c, 'backend')).reason, 'REQUEST_NOT_FOUND'); assert.deepEqual(await f.db.getWorkflow(f.c.requestId), f.s);
});
test('stored NOT_READY audits do not claim an accepted routing decision', async () => {
  const f = routingFixture(), s = await at(f.db, 'WAITING_FOR_SCREENING'), c = routingCommand(s); const r = await f.routing.execute(c, 'backend');
  const a = (await f.db.listAudit(c.requestId)).find(a => a.auditId === r.auditId)!; assert.equal(a.outcome, 'REJECTED'); assert.equal(a.reason, 'NOT_READY'); assert.equal(a.routing, undefined);
});

test('identical commit between receipt and workflow reads replays rather than returning stale', async () => {
  const f = await ready(); let reads = 0;
  const store = wrapStore(f.db, { getReceipt: async (id, event) => {
    const previous = await f.db.getReceipt(id, event);
    if (++reads === 1) assert.equal((await f.routing.execute(f.c, 'backend')).status, 'SUCCESS');
    return previous;
  } });
  const service = new RoutingService({ ...f.deps, store }); const r = await service.execute(f.c, 'backend'); assert.equal(r.status, 'DUPLICATE_EVENT'); assert.equal((await f.db.getWorkflow(f.c.requestId))!.version, f.s.version + 1);
});
test('store re-resolves routing roles at the final write boundary', async () => {
  let revoke = false;
  const f = routingFixture({ resolveActor: p => p === 'backend' && revoke ? { id: 'fictional-backend', roles: ['PO'] } : resolveReviewActor(p) });
  const s = await at(f.db, 'READY_TO_ROUTE'); revoke = true;
  const r = await f.routing.execute(routingCommand(s), 'backend'); assert.equal(r.reason, 'WRONG_ROLE'); assert.deepEqual(await f.db.getWorkflow('fictional-001'), s);
});
test('an extra policy restriction revoked before commit cannot be bypassed', async () => {
  const f = await ready(); let calls = 0; const service = new RoutingService({ ...f.deps, authorizeActor: () => ++calls === 1 });
  assert.equal((await service.execute(f.c, 'backend')).reason, 'WRONG_ROLE'); assert.deepEqual(await f.db.getWorkflow('fictional-001'), f.s);
});
test('PO confirmation evidence must be attributed to the current request owner', async () => {
  const f = await ready(); const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).map(r => r.event.type === 'PO_DECISION' ? { ...r, event: { ...r.event, actor: { ...r.event.actor, id: 'fictional-other-po' } } } : r) }) });
  assert.equal((await service.execute(f.c, 'backend')).status, 'NOT_READY');
});
test('accepted receipt missing routing details fails closed on retry', async () => {
  const f = await ready(); await f.routing.execute(f.c, 'backend');
  const service = new RoutingService({ ...f.deps, store: wrapStore(f.db, { getReceipt: async (id, event) => { const receipt = await f.db.getReceipt(id, event); if (!receipt) return null; const { routing: _routing, ...broken } = receipt; return broken; } }) });
  assert.equal((await service.execute(f.c, 'backend')).status, 'STORAGE_FAILURE');
});
test('legacy accepted routing event cannot be overwritten by a new application command', async () => {
  const { next } = await import('./helpers/approval-fixtures.ts'); const f = await ready(), step = next(f.s);
  await f.db.apply(step.cmd, step.who); const c = { ...f.c, eventId: step.cmd.event.eventId };
  assert.equal((await f.routing.execute(c, 'backend')).reason, 'EVENT_ID_REUSED');
});
test('same actor with a fresh service instance can retry from persisted receipt', async () => {
  const f = await ready(); await f.routing.execute(f.c, 'backend');
  const service = new RoutingService(f.deps); assert.equal((await service.execute(f.c, 'backend')).status, 'DUPLICATE_EVENT');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createLocalApi } from '../src/server.ts';
import { ApprovalService } from '../src/approvals.ts';
import { RoutingService } from '../src/routing-service.ts';
import { at } from './helpers/approval-fixtures.ts';
import { reviewerHeaders, resolveReviewActor } from './helpers/review-fixtures.ts';
import { routingFixture, routingCommand, readyWithConcern } from './helpers/routing-service-fixtures.ts';
import { wrapStore } from './helpers/api-fixtures.ts';
const url = '/api/requests/fictional-001/route';
function harness(t: TestContext, f = routingFixture()) {
  const api = createLocalApi({ store: f.db, approvals: new ApprovalService({ store: f.db, resolveActor: resolveReviewActor }),
    routing: f.routing, reviews: f.reviews, authentication: f.authentication }); t.after(() => api.close());
  return { ...f, api };
}
const bodyFor = (c: ReturnType<typeof routingCommand>) => { const { requestId: _id, ...body } = c; return body; };

test('HTTP explicit route commits a clear request without starting Bedrock', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE');
  const response = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) });
  assert.equal(response.statusCode, 200, response.body); const r = response.json(); assert.equal(r.status, 'SUCCESS'); assert.equal(r.routing.route, 'READY_FOR_BEDROCK_REVIEW');
  assert.equal(r.routing.screeningId, s.screening!.screeningId); assert.equal(r.routing.confirmationId, s.confirmation!.confirmationId); assert.equal(r.routing.snapshotHash, s.brief.snapshotHash);
  assert.equal(r.routing.clinicalApprovalRequired, true); assert.equal(r.workflowVersion, s.version + 1);
  const state = (await f.db.getWorkflow('fictional-001'))!; assert.equal(state.status, 'READY_FOR_LOGIC_PROPOSAL'); assert.equal(state.logic, null); assert.equal(state.clinicalApproval, null); assert.equal(state.releaseApproval, null);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal('listen' in f.api, false);
});
test('HTTP concern route is visible in existing authorized SD queue and context', async t => {
  const f = harness(t), s = await readyWithConcern(f.db);
  const response = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) });
  assert.equal(response.statusCode, 200); assert.equal(response.json().routing.route, 'NEEDS_SD_REVIEW');
  const queue = await f.api.inject({ method: 'GET', url: '/api/reviews/queue?category=SERVICE_DESIGNER', headers: reviewerHeaders('sd') });
  assert.equal(queue.statusCode, 200); assert.equal(queue.json().items.length, 1); assert.equal(queue.json().items[0].workflowVersion, s.version + 1); assert.equal(queue.json().items[0].assignee, undefined);
  const context = await f.api.inject({ method: 'GET', url: '/api/requests/fictional-001/review-context?category=SERVICE_DESIGNER', headers: reviewerHeaders('sd') });
  assert.equal(context.statusCode, 200); assert.equal(context.json().eligibility.eligible, true); assert.equal(context.json().unresolvedFindings[0].area, 'clinicalSafety');
});
for (const status of ['WAITING_FOR_SCREENING', 'WAITING_FOR_PO_CONFIRMATION'] as const) test(`HTTP ${status} returns structured NOT_READY 409 and no SD task`, async t => {
  const f = harness(t), s = await at(f.db, status), body = bodyFor(routingCommand(s));
  for (let i = 0; i < 2; i++) {
    const r = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: body });
    assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().error.code, 'NOT_READY'); assert.equal(r.json().routing.route, 'NOT_READY');
    assert.ok(r.json().routing.reasons.some((r: { code: string }) => r.code === 'PO_NOT_CONFIRMED'));
  }
  assert.deepEqual(await f.db.getWorkflow('fictional-001'), s);
  const queue = await f.api.inject({ method: 'GET', url: '/api/reviews/queue?category=SERVICE_DESIGNER', headers: reviewerHeaders('sd') }); assert.deepEqual(queue.json().items, []);
});
test('HTTP missing authentication rejects routing', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE'); const r = await f.api.inject({ method: 'POST', url, payload: bodyFor(routingCommand(s)) }); assert.equal(r.statusCode, 401);
});
test('HTTP mock token has no meaning unless the test provider is explicitly injected', async t => {
  const f = routingFixture(), s = await at(f.db, 'READY_TO_ROUTE');
  const api = createLocalApi({ store: f.db, approvals: new ApprovalService({ store: f.db, resolveActor: resolveReviewActor }), routing: f.routing }); t.after(() => api.close());
  const r = await api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) }); assert.equal(r.statusCode, 401);
});
for (const who of ['po', 'clinic', 'sd', 'release', 'ai']) test(`HTTP ${who} cannot route using role spoof headers`, async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE');
  const r = await f.api.inject({ method: 'POST', url, headers: { ...reviewerHeaders(who), 'x-roles': 'ORCHESTRATOR', 'x-actor-id': 'fictional-backend' }, payload: bodyFor(routingCommand(s)) });
  assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'WRONG_ROLE'); assert.deepEqual(await f.db.getWorkflow('fictional-001'), s);
});
test('HTTP inaccessible and nonexistent requests share a generic 404', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE'), payload = bodyFor(routingCommand(s));
  const denied = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('outsider'), payload });
  const missing = await f.api.inject({ method: 'POST', url: '/api/requests/missing/route', headers: reviewerHeaders('backend'), payload });
  assert.equal(denied.statusCode, 404); assert.equal(missing.statusCode, 404); assert.deepEqual(denied.json(), missing.json());
});
for (const change of [{ expectedVersion: 1 }, { revision: 2 }, { snapshotHash: 'e'.repeat(64) }]) test(`HTTP stale ${Object.keys(change)[0]} returns 409`, async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE');
  const r = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: { ...bodyFor(routingCommand(s)), ...change } });
  assert.equal(r.statusCode, 409); assert.ok(['VERSION_CONFLICT', 'STALE_REQUEST'].includes(r.json().error.code)); assert.deepEqual(await f.db.getWorkflow('fictional-001'), s);
});
test('HTTP identical retry returns DUPLICATE_EVENT without another transition', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE'), options = { method: 'POST' as const, url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) };
  const a = await f.api.inject(options), b = await f.api.inject(options); assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200); assert.equal(b.json().status, 'DUPLICATE_EVENT'); assert.deepEqual(a.json().routing, b.json().routing);
  assert.equal((await f.db.getWorkflow('fictional-001'))!.version, s.version + 1);
});
test('HTTP changed accepted event reuse is a conflict', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE'), body = bodyFor(routingCommand(s));
  await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: body });
  const r = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: { ...body, snapshotHash: 'f'.repeat(64) } }); assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'EVENT_ID_REUSED');
});
test('HTTP distinct concurrent routing commands consume one workflow version', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE'), body = bodyFor(routingCommand(s));
  const results = await Promise.all(['one', 'two'].map(eventId => f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: { ...body, eventId } })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]); assert.equal((await f.db.getWorkflow('fictional-001'))!.version, s.version + 1);
});
test('HTTP concurrent identical routing retries are idempotent', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE'), options = { method: 'POST' as const, url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) };
  const results = await Promise.all([f.api.inject(options), f.api.inject(options)]); assert.deepEqual(results.map(r => r.statusCode), [200, 200]); assert.deepEqual(results.map(r => r.json().status).sort(), ['DUPLICATE_EVENT', 'SUCCESS']);
});
for (const extra of [{ actorId: 'backend' }, { roles: ['ORCHESTRATOR'] }, { trusted: true }, { screeningStatus: 'ASSESSED' },
  { screening: { status: 'COMPLETED' } }, { confirmation: { decision: 'CONFIRMED' } }, { route: 'READY_FOR_BEDROCK_REVIEW' }, { dispatch: true }, { requestId: 'different-request' }]) test(`HTTP rejects browser ${Object.keys(extra)[0]} with 400`, async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE');
  const r = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: { ...bodyFor(routingCommand(s)), ...extra } }); assert.equal(r.statusCode, 400); assert.deepEqual(await f.db.getWorkflow('fictional-001'), s);
});
for (const change of [{ expectedVersion: '3' }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { revision: -1 }, { snapshotHash: 'bad-hash' }, { eventId: '' }]) test(`HTTP malformed ${Object.keys(change)[0]} returns 400`, async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE');
  const r = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: { ...bodyFor(routingCommand(s)), ...change } }); assert.equal(r.statusCode, 400);
});
test('HTTP malformed JSON and unexpected query fields are rejected', async t => {
  const f = harness(t), s = await at(f.db, 'READY_TO_ROUTE');
  const malformed = await f.api.inject({ method: 'POST', url, headers: { ...reviewerHeaders('backend'), 'content-type': 'application/json' }, payload: '{invalid-json' }); assert.equal(malformed.statusCode, 400);
  const query = await f.api.inject({ method: 'POST', url: url + '?trusted=true', headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) }); assert.equal(query.statusCode, 400);
});
test('HTTP failed storage commit returns sanitized 503 and leaves no partial result', async t => {
  let fail = false; const f = harness(t, routingFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('private database credentials'); } } })), s = await at(f.db, 'READY_TO_ROUTE');
  const before = await f.db.listAudit('fictional-001'); fail = true;
  const r = await f.api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) }); fail = false;
  assert.equal(r.statusCode, 503); assert.equal(r.body.includes('private'), false); assert.deepEqual(await f.db.getWorkflow('fictional-001'), s); assert.deepEqual(await f.db.listAudit('fictional-001'), before);
});
test('HTTP missing stored screening record yields structured NOT_READY', async t => {
  const f = routingFixture(), s = await at(f.db, 'READY_TO_ROUTE');
  const routing = new RoutingService({ ...f.deps, store: wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).filter(r => r.kind !== 'SCREENING_COMPLETED') }) });
  const api = createLocalApi({ store: f.db, routing, approvals: new ApprovalService({ store: f.db, resolveActor: resolveReviewActor }), authentication: f.authentication }); t.after(() => api.close());
  const r = await api.inject({ method: 'POST', url, headers: reviewerHeaders('backend'), payload: bodyFor(routingCommand(s)) }); assert.equal(r.statusCode, 409); assert.equal(r.json().routing.route, 'NOT_READY'); assert.ok(r.json().routing.reasons.some((r: { field: string }) => r.field === 'screening'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createLocalApi } from '../src/server.ts';
import { ApprovalService } from '../src/approvals.ts';
import { RequestService } from '../src/requests.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';
import { content } from './helpers/approval-fixtures.ts';
import { requestFixture, headers, mockRole3, resolveRequestActor } from './helpers/request-fixtures.ts';
import { wrapStore } from './helpers/api-fixtures.ts';
import type { InMemoryOptions } from '../src/storage/memory.ts';

const body = (eventId = 'fictional-http-create') => ({ eventId, expectedVersion: 0, content: content() });
function harness(t: TestContext, options: Partial<InMemoryOptions> = {}) {
  const f = requestFixture(options), api = createLocalApi({ store: f.db, approvals: new ApprovalService({ store: f.db, resolveActor: resolveRequestActor }),
    authentication: f.authentication, requests: f.service });
  t.after(() => api.close());
  return { ...f, api, create: (payload: unknown = body(), who = 'po') => api.inject({ method: 'POST', url: '/api/requests', headers: headers(who), payload: payload as object }) };
}
async function screened(t: TestContext) {
  const f = harness(t), response = await f.create(); assert.equal(response.statusCode, 201, response.body);
  const r = response.json(); const screen = await mockRole3(f.service).screen({ ...r.request, expectedVersion: r.workflowVersion, eventId: 'internal-screen-event' });
  assert.equal(screen.status, 'SUCCESS', screen.reason);
  const state = (await f.db.getWorkflow(r.requestId))!;
  return { ...f, id: r.requestId as string, state,
    confirmation: { eventId: 'fictional-http-confirm', expectedVersion: state.version, revision: state.brief.revision,
      snapshotHash: state.brief.snapshotHash, screeningId: state.screening!.screeningId, decision: 'CONFIRMED' } };
}

test('HTTP creates request with 201, then returns the owner-only preview', async t => {
  const f = harness(t), r = await f.create(); assert.equal(r.statusCode, 201, r.body); const data = r.json();
  assert.match(data.requestId, /^req-[a-f0-9]{64}$/); assert.equal(data.request.revision, 1); assert.equal(data.workflowVersion, 1);
  const get = await f.api.inject({ method: 'GET', url: `/api/requests/${data.requestId}`, headers: headers('po') });
  assert.equal(get.statusCode, 200, get.body); const view = get.json(); assert.equal(view.status, 'WAITING_FOR_SCREENING');
  assert.deepEqual(view.preview.content, content()); assert.equal(view.screening, null); assert.equal(view.clinicalApprovalRequired, true);
  assert.equal(view.ownerId, undefined); assert.equal(view.processedEvents, undefined); assert.equal('listen' in f.api, false);
});
for (const who of ['clinic', 'ai', 'release']) test(`HTTP ${who} cannot create a request`, async t => {
  const f = harness(t), r = await f.create(body(), who); assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'WRONG_ROLE');
});
test('creation cannot bypass missing authentication', async t => {
  const f = harness(t), r = await f.api.inject({ method: 'POST', url: '/api/requests', payload: body() }); assert.equal(r.statusCode, 401);
});
test('identity headers do not authenticate request creation', async t => {
  const f = harness(t), r = await f.api.inject({ method: 'POST', url: '/api/requests', headers: { 'x-roles': 'PO', 'x-actor-id': 'fictional-po', 'x-trusted': 'true' }, payload: body() });
  assert.equal(r.statusCode, 401);
});
test('registered request routes still deny access when authentication is omitted', async t => {
  const f = requestFixture(), api = createLocalApi({ store: f.db, requests: f.service, approvals: new ApprovalService({ store: f.db, resolveActor: resolveRequestActor }) });
  t.after(() => api.close()); const r = await api.inject({ method: 'POST', url: '/api/requests', headers: headers('po'), payload: body() }); assert.equal(r.statusCode, 401);
});
test('another PO cannot retrieve or confirm a request even with known hashes', async t => {
  const f = await screened(t), before = await f.db.listAudit(f.id);
  for (const request of [{ method: 'GET' as const, url: `/api/requests/${f.id}` },
    { method: 'POST' as const, url: `/api/requests/${f.id}/confirmations`, payload: f.confirmation }]) {
    const r = await f.api.inject({ ...request, headers: headers('po2') }); assert.equal(r.statusCode, 404);
    assert.deepEqual(r.json(), { error: { code: 'REQUEST_NOT_FOUND', message: 'Request not found.' } });
  }
  assert.deepEqual(await f.db.listAudit(f.id), before);
});
test('missing and inaccessible request GET responses match', async t => {
  const f = await screened(t);
  const missing = await f.api.inject({ method: 'GET', url: '/api/requests/missing', headers: headers('po') });
  const denied = await f.api.inject({ method: 'GET', url: `/api/requests/${f.id}`, headers: headers('po2') });
  assert.equal(missing.statusCode, 404); assert.equal(denied.statusCode, 404); assert.deepEqual(missing.json(), denied.json());
});
test('current confirmation records agreement only and leaves routing explicit', async t => {
  const f = await screened(t), r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: f.confirmation });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().status, 'SUCCESS');
  const s = (await f.db.getWorkflow(f.id))!; assert.equal(s.status, 'READY_TO_ROUTE'); assert.equal(s.routing, null); assert.equal(s.clinicalApproval, null); assert.equal(s.releaseApproval, null);
  const get = await f.api.inject({ method: 'GET', url: `/api/requests/${f.id}`, headers: headers('po') });
  assert.equal(get.json().confirmation.screeningId, s.screening!.screeningId); assert.equal(get.json().screening.checks.clinicalSafety.outcome, 'CLEAR');
});
test('confirmation before screening returns 409 without advancing', async t => {
  const f = harness(t), created = (await f.create()).json();
  const r = await f.api.inject({ method: 'POST', url: `/api/requests/${created.requestId}/confirmations`, headers: headers('po'), payload: {
    eventId: 'early-confirm', expectedVersion: created.workflowVersion, revision: created.request.revision, snapshotHash: created.request.snapshotHash,
    screeningId: 'not-screened', decision: 'CONFIRMED',
  } }); assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'WRONG_STATE');
});
for (const changes of [{ expectedVersion: 1 }, { revision: 2 }, { snapshotHash: 'e'.repeat(64) }, { screeningId: 'wrong-screen' }]) test(`HTTP rejects stale confirmation ${Object.keys(changes)[0]}`, async t => {
  const f = await screened(t), r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: { ...f.confirmation, ...changes } });
  assert.equal(r.statusCode, 409); assert.deepEqual(await f.db.getWorkflow(f.id), f.state);
});
test('HTTP correction and revision require rescreening and preserve old snapshot history', async t => {
  const f = await screened(t), correction = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: { ...f.confirmation, decision: 'REVISION_REQUESTED' } });
  assert.equal(correction.statusCode, 200); assert.equal((await f.db.getWorkflow(f.id))!.status, 'RETURNED_FOR_CLARIFICATION');
  const r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/revisions`, headers: headers('po'), payload: {
    ...f.confirmation, eventId: 'material-revision', expectedVersion: correction.json().workflowVersion, screeningId: undefined, decision: undefined, content: content(2),
  } }); assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().request.revision, 2);
  const s = (await f.db.getWorkflow(f.id))!; assert.equal(s.status, 'WAITING_FOR_SCREENING'); assert.equal(s.screening, null); assert.equal(s.confirmation, null);
  assert.equal((await f.db.listSnapshots(f.id)).length, 2); assert.equal((await f.db.listSnapshots(f.id))[0].snapshotHash, f.state.brief.snapshotHash);
});
test('HTTP no-op revision is a conflict and cannot manufacture a new revision', async t => {
  const f = await screened(t), { screeningId: _screen, decision: _decision, ...base } = f.confirmation;
  const r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/revisions`, headers: headers('po'), payload: { ...base, content: content() } });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'NO_MATERIAL_CHANGE'); assert.equal((await f.db.listSnapshots(f.id)).length, 1);
});
test('duplicate HTTP submissions return 200 and the same request identity', async t => {
  const f = harness(t), a = await f.create(), b = await f.create(); assert.equal(a.statusCode, 201); assert.equal(b.statusCode, 200);
  assert.equal(b.json().status, 'DUPLICATE_EVENT'); assert.equal(b.json().requestId, a.json().requestId);
  assert.equal((await f.db.getWorkflow(a.json().requestId))!.version, 1);
});
test('duplicate HTTP confirmation returns 200 without a repeated PO event', async t => {
  const f = await screened(t), options = { method: 'POST' as const, url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: f.confirmation };
  const a = await f.api.inject(options), b = await f.api.inject(options); assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200); assert.equal(b.json().status, 'DUPLICATE_EVENT');
  assert.equal((await f.db.listEvidence(f.id)).filter(r => r.kind === 'PO_DECISION').length, 1);
});
test('HTTP changed duplicate submission returns 409', async t => {
  const f = harness(t); await f.create(); const r = await f.create({ ...body(), content: content(2) }); assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'EVENT_ID_REUSED');
});
test('concurrent HTTP submission retries return one newly created request', async t => {
  const f = harness(t), responses = await Promise.all([f.create(), f.create()]); assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 201]); assert.equal(responses[0].json().requestId, responses[1].json().requestId);
});
test('concurrent HTTP confirmations cannot advance the same version twice', async t => {
  const f = await screened(t), responses = await Promise.all(['a', 'b'].map(eventId => f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: { ...f.confirmation, eventId } })));
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 409]); assert.equal((await f.db.getWorkflow(f.id))!.version, f.state.version + 1);
});
for (const extra of [{ requestId: 'chosen' }, { actorId: 'someone' }, { roles: ['PO'] }, { trusted: true }, { screening: { status: 'COMPLETED' } }, { type: 'SUBMIT' }, { clinicalApproval: true }]) test(`creation rejects extra ${Object.keys(extra)[0]} with 400`, async t => {
  const f = harness(t), r = await f.create({ ...body(), ...extra }); assert.equal(r.statusCode, 400);
});
for (const extra of [{ actorId: 'someone' }, { roles: ['PO'] }, { passed: true }, { screening: { status: 'COMPLETED' } }, { trusted: true }]) test(`confirmation rejects extra ${Object.keys(extra)[0]} with 400`, async t => {
  const f = await screened(t), r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: { ...f.confirmation, ...extra } }); assert.equal(r.statusCode, 400);
});
for (const changes of [{ expectedVersion: '0' }, { expectedVersion: 1 }, { content: {} }, { content: { ...content(), ownerId: 'spoof' } }, { eventId: '' }]) test(`invalid creation ${Object.keys(changes)[0]} returns 400`, async t => {
  const f = harness(t), r = await f.create({ ...body(), ...changes }); assert.equal(r.statusCode, 400);
});
test('browser cannot POST preliminary screening or interpretation results', async t => {
  const f = await screened(t);
  for (const suffix of ['screening', 'screenings', 'interpretations']) {
    const r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/${suffix}`, headers: headers('po'), payload: { trusted: true } }); assert.equal(r.statusCode, 404);
  }
});
test('a PO cannot use a confirmation to bypass downstream clinical approval', async t => {
  const f = await screened(t); await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/confirmations`, headers: headers('po'), payload: f.confirmation });
  const s = (await f.db.getWorkflow(f.id))!;
  const r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/clinical-decisions`, headers: headers('po'), payload: {
    eventId: 'bypass-clinical', expectedVersion: s.version, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    logicRevision: 1, logicHash: 'e'.repeat(64), checkerReportId: 'fake-checks', decision: 'APPROVE',
  } }); assert.ok([403, 409].includes(r.statusCode)); assert.deepEqual(await f.db.getWorkflow(f.id), s);
});
test('failed creation commit returns sanitized 503 with retry safe storage', async t => {
  let fail = true; const f = harness(t, { testFaults: { beforeCommit: () => { if (fail) throw Error('private storage detail'); } } });
  const r = await f.create(); assert.equal(r.statusCode, 503); assert.equal(r.body.includes('private storage'), false);
  fail = false; const success = await f.create(); assert.equal(success.statusCode, 201);
});
test('request retrieval storage failure returns sanitized 503', async t => {
  const f = requestFixture(), created = await f.service.create({ ...body(), expectedVersion: 0 }, 'po');
  const service = new RequestService({ store: wrapStore(f.db, { getWorkflow: async () => { throw Error('private database'); } }), resolveActor: resolveRequestActor, validateSnapshot: provisionalSnapshotValidator });
  const api = createLocalApi({ store: f.db, requests: service, approvals: new ApprovalService({ store: f.db, resolveActor: resolveRequestActor }), authentication: f.authentication }); t.after(() => api.close());
  const r = await api.inject({ method: 'GET', url: `/api/requests/${created.requestId}`, headers: headers('po') }); assert.equal(r.statusCode, 503); assert.equal(r.body.includes('private database'), false);
});

test('another PO cannot submit a material revision', async t => {
  const f = await screened(t), { screeningId: _screen, decision: _decision, ...base } = f.confirmation;
  const r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/revisions`, headers: headers('po2'), payload: { ...base, content: content(2) } });
  assert.equal(r.statusCode, 404); assert.deepEqual(await f.db.getWorkflow(f.id), f.state);
});
test('new request GET and mutation endpoints require authentication', async t => {
  const f = await screened(t);
  for (const [method, suffix, payload] of [['GET', '', undefined], ['POST', '/confirmations', f.confirmation], ['POST', '/revisions', {}]] as const) {
    const r = await f.api.inject({ method, url: `/api/requests/${f.id}${suffix}`, ...(payload ? { payload } : {}) }); assert.equal(r.statusCode, 401);
  }
});
test('revision rejects browser-supplied screening or approval claims', async t => {
  const f = await screened(t), { screeningId: _screen, decision: _decision, ...base } = f.confirmation;
  const r = await f.api.inject({ method: 'POST', url: `/api/requests/${f.id}/revisions`, headers: headers('po'), payload: {
    ...base, content: content(2), screening: f.state.screening, clinicalApproval: true,
  } }); assert.equal(r.statusCode, 400); assert.deepEqual(await f.db.getWorkflow(f.id), f.state);
});

test('request GET preserves every stored hashed content field instead of silently trimming extensions', async t => {
  const { createSnapshot, requestPreviewIdentity } = await import('../src/snapshots.ts');
  const f = harness(t), requestId = 'fictional-extended-preview';
  const extended = { ...content(), sources: [{ id: 'fictional-training-guide', title: 'Fictional reference' }] };
  const snapshot = createSnapshot({ requestId, revision: 1, kind: 'REQUEST_PREVIEW', schemaVersion: '1.0', content: extended }, provisionalSnapshotValidator);
  const identity = requestPreviewIdentity(snapshot);
  await f.db.apply({ requestId, attemptId: 'extended-create-attempt', event: {
    type: 'SUBMIT', eventId: 'extended-create', expectedVersion: 0, request: identity, brief: { ...extended, ...identity },
  }, snapshots: [snapshot] }, 'po');
  const response = await f.api.inject({ method: 'GET', url: `/api/requests/${requestId}`, headers: headers('po') });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json().preview.content, extended); assert.equal(response.json().preview.snapshotHash, snapshot.snapshotHash);
});

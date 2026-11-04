import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createLocalApi } from '../src/server.ts';
import type { LocalApiDependencies } from '../src/server.ts';
import { ApprovalService } from '../src/approvals.ts';
import { at, store, resolveActor, next } from './helpers/approval-fixtures.ts';
import { clinicalBody, releaseBody, sessionHeaders, testAuthentication, wrapStore } from './helpers/api-fixtures.ts';
import type { OrchestratorStore } from '../src/storage/requests.ts';

function harness(t: TestContext, db: OrchestratorStore, options: Partial<LocalApiDependencies> = {}) {
  let attempt = 0;
  const api = createLocalApi({ store: db, approvals: new ApprovalService({ store: db, resolveActor,
    newAttemptId: () => `http-attempt-${++attempt}` }), authentication: testAuthentication, ...options });
  t.after(() => api.close()); return api;
}
const route = (id: string, suffix: string) => `/api/requests/${id}/${suffix}`;

test('authorized status returns only request status and current version', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'GET', url: route(s.brief.requestId, 'status'), headers: sessionHeaders('po') });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), { requestId: s.brief.requestId, status: s.status, version: s.version });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal('listen' in api, false); assert.equal('server' in api, false);
});
for (const suffix of ['status', 'clinical-decisions', 'release-decisions']) test(`missing authentication blocks ${suffix}`, async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db), before = await db.listAudit(s.brief.requestId);
  const r = await api.inject({ method: suffix === 'status' ? 'GET' : 'POST', url: route(s.brief.requestId, suffix),
    ...(suffix === 'status' ? {} : { payload: clinicalBody(s) }) });
  assert.equal(r.statusCode, 401); assert.equal(r.json().error.code, 'AUTHENTICATION_REQUIRED');
  assert.deepEqual(await db.listAudit(s.brief.requestId), before);
});
test('omitted authentication denies even fictional test tokens by default', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING');
  const api = createLocalApi({ store: db, approvals: new ApprovalService({ store: db, resolveActor }) }); t.after(() => api.close());
  const r = await api.inject({ method: 'GET', url: route(s.brief.requestId, 'status'), headers: sessionHeaders('clinic') });
  assert.equal(r.statusCode, 401);
});
test('actor, role and trusted headers do not authenticate a caller', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), api = harness(t, db);
  const r = await api.inject({ method: 'GET', url: route(s.brief.requestId, 'status'), headers: {
    'x-actor-id': 'fictional-clinician', 'x-roles': 'CLINICIAN', 'x-trusted': 'true', authorization: 'Bearer clinic',
  } }); assert.equal(r.statusCode, 401);
});
test('inaccessible and nonexistent requests share the same non-leaking 404 response', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'); let reads = 0;
  const facade = wrapStore(db, { getWorkflow: async id => { reads++; return db.getWorkflow(id); } });
  const api = harness(t, facade);
  const denied = await api.inject({ method: 'GET', url: route(s.brief.requestId, 'status'), headers: sessionHeaders('outsider') });
  assert.equal(reads, 0);
  const missing = await api.inject({ method: 'GET', url: route('fictional-missing', 'status'), headers: sessionHeaders('clinic') });
  assert.equal(denied.statusCode, 404); assert.equal(missing.statusCode, 404); assert.deepEqual(denied.json(), missing.json());
});
test('inaccessible decision requests are rejected before calling the application service', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'); let calls = 0;
  const api = harness(t, db, { approvals: { execute: async () => { calls++; throw new Error('must not run'); } } });
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('outsider'), payload: clinicalBody(s) });
  assert.equal(r.statusCode, 404); assert.equal(calls, 0);
});
test('authorized clinician decision delegates to ApprovalService and records the exact model', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db), body = clinicalBody(s);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: body });
  assert.equal(r.statusCode, 200); const data = r.json();
  assert.equal(data.outcome, 'DECISION_RECORDED'); assert.equal(data.decision, 'APPROVE'); assert.equal(data.reviewType, 'CLINICAL_CONTENT');
  assert.equal(data.decisionRecorded, true); assert.equal(data.duplicate, false); assert.equal(data.workflowVersion, s.version + 1);
  const updated = (await db.getWorkflow(s.brief.requestId))!; assert.equal(updated.status, 'CLINICALLY_APPROVED'); assert.equal(updated.clinicalApproval!.logicHash, body.logicHash);
});
for (const [who, reason] of [['po', 'WRONG_ROLE'], ['poClinic', 'SELF_APPROVAL']] as const) test(`${who} cannot clinically approve through HTTP`, async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: { ...sessionHeaders(who), 'x-roles': 'CLINICIAN', 'x-actor-id': 'fictional-clinician' }, payload: clinicalBody(s) });
  assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, reason); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
  assert.equal((await db.listAudit(s.brief.requestId)).at(-1)!.outcome, 'REJECTED');
});
for (const changes of [{ logicHash: 'e'.repeat(64) }, { expectedVersion: 0 }]) test(`stale clinical ${Object.keys(changes)[0]} is a conflict`, async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: { ...clinicalBody(s), ...changes } });
  assert.equal(r.statusCode, 409); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('authorized release records approval but does not make a download available automatically', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'release-decisions'), headers: sessionHeaders('release'), payload: releaseBody(s) });
  assert.equal(r.statusCode, 200); assert.equal(r.json().reviewType, 'RELEASE'); assert.equal(r.json().decision, 'APPROVE');
  assert.equal((await db.getWorkflow(s.brief.requestId))!.status, 'RELEASE_APPROVED'); assert.equal('downloadUrl' in r.json(), false);
});
for (const who of ['po', 'clinicRelease']) test(`${who} cannot authorize release`, async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'release-decisions'), headers: sessionHeaders(who), payload: releaseBody(s) });
  assert.equal(r.statusCode, 403); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('failed verification cannot be bypassed through a release decision', async t => {
  const db = store(), s = await at(db, 'VERIFYING'), step = next(s); if (step.cmd.event.type !== 'VERIFIED') throw new Error('fixture');
  await db.apply({ ...step.cmd, event: { ...step.cmd.event, evidence: { ...step.cmd.event.evidence, passed: false } } }, step.who);
  const failed = (await db.getWorkflow(s.brief.requestId))!, api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'release-decisions'), headers: sessionHeaders('release'), payload: releaseBody(failed) });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'VERIFICATION_REQUIRED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), failed);
});
test('mismatched artifact hash cannot authorize a release', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'release-decisions'), headers: sessionHeaders('release'), payload: { ...releaseBody(s), artifactHash: 'e'.repeat(64) } });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'STALE_ARTIFACT'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('release still requires the current clinical approval', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
  const facade = wrapStore(db, { getWorkflow: async id => { const loaded = await db.getWorkflow(id); return loaded ? { ...loaded, clinicalApproval: null } : null; } });
  const api = harness(t, facade);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'release-decisions'), headers: sessionHeaders('release'), payload: releaseBody(s) });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'CLINICAL_APPROVAL_REQUIRED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
for (const phase of ['clinical', 'release'] as const) for (const decision of ['REJECT', 'RETURN'] as const) test(`${phase} ${decision} is recorded as a decision, never approval granted`, async t => {
  const db = store(), s = await at(db, phase === 'clinical' ? 'WAITING_FOR_CLINICAL_APPROVAL' : 'WAITING_FOR_RELEASE_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, `${phase}-decisions`), headers: sessionHeaders(phase === 'clinical' ? 'clinic' : 'release'),
    payload: { ...(phase === 'clinical' ? clinicalBody(s) : releaseBody(s)), decision, note: 'Fictional review requires correction.' } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().decision, decision); assert.equal(r.json().decisionRecorded, true); assert.equal('approvalGranted' in r.json(), false);
  const updated = (await db.getWorkflow(s.brief.requestId))!; assert.equal(updated.status, decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION');
  assert.equal(phase === 'clinical' ? updated.clinicalApproval : updated.releaseApproval, null);
});
for (const phase of ['clinical', 'release'] as const) test(`duplicate ${phase} submissions return idempotent 200 without advancing twice`, async t => {
  const db = store(), s = await at(db, phase === 'clinical' ? 'WAITING_FOR_CLINICAL_APPROVAL' : 'WAITING_FOR_RELEASE_APPROVAL'), api = harness(t, db);
  const options = { method: 'POST' as const, url: route(s.brief.requestId, `${phase}-decisions`), headers: sessionHeaders(phase === 'clinical' ? 'clinic' : 'release'), payload: phase === 'clinical' ? clinicalBody(s) : releaseBody(s) };
  const first = await api.inject(options), second = await api.inject(options);
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200); assert.equal(second.json().duplicate, true); assert.equal(second.json().outcome, 'DUPLICATE_EVENT');
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version + 1);
  assert.equal((await db.listEvidence(s.brief.requestId)).filter(r => r.kind === (phase === 'clinical' ? 'CLINICAL_DECISION' : 'RELEASE_DECISION')).length, 1);
});
test('same event ID with changed approval reference returns 409', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db), body = clinicalBody(s);
  await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: body });
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: { ...body, checkerReportId: 'changed-report' } });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'EVENT_ID_REUSED');
});
for (const extra of [{ actor: 'clinic' }, { actorId: 'clinic' }, { roles: ['CLINICIAN'] }, { trusted: true }, { passed: true },
  { expectedActorId: 'clinic' }, { requestId: 'different-request' }, { type: 'CLINICAL_DECISION' }, { evidence: { passed: true } }]) {
  test(`unexpected body field ${Object.keys(extra)[0]} is rejected, not removed`, async t => {
    const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db), before = await db.listAudit(s.brief.requestId);
    const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: { ...clinicalBody(s), ...extra } });
    assert.equal(r.statusCode, 400); assert.equal(r.json().error.code, 'INVALID_INPUT'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await db.listAudit(s.brief.requestId), before);
  });
}
for (const changes of [{ expectedVersion: '7' }, { expectedVersion: -1 }, { expectedVersion: 1.5 }, { logicHash: 'fake' }, { checkerReportId: '' },
  { decision: 'CONFIRMED' }, { decision: 'REJECT' }, { decision: 'RETURN', note: ' ' }]) test(`invalid input ${JSON.stringify(changes)} returns 400`, async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: { ...clinicalBody(s), ...changes } });
  assert.equal(r.statusCode, 400); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('missing required evidence fields return 400', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  const body: Record<string, unknown> = { ...clinicalBody(s) }; delete body.checkerReportId;
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: body }); assert.equal(r.statusCode, 400);
});
test('malformed JSON, arrays and missing bodies are rejected safely', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  for (const payload of ['{invalid-json', 'null', '[]', '']) {
    const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: { ...sessionHeaders('clinic'), 'content-type': 'application/json' }, payload });
    assert.equal(r.statusCode, 400); assert.deepEqual(r.json(), { error: { code: 'INVALID_INPUT', message: 'Invalid request input.' } });
  }
});
test('unexpected query fields cannot override identity or command fields', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), api = harness(t, db);
  const r = await api.inject({ method: 'GET', url: route(s.brief.requestId, 'status') + '?actorId=clinic', headers: sessionHeaders('po') }); assert.equal(r.statusCode, 400);
});
test('nonexistent decision target returns the same generic 404', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route('fictional-missing', 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: clinicalBody(s) });
  assert.equal(r.statusCode, 404); assert.deepEqual(r.json(), { error: { code: 'REQUEST_NOT_FOUND', message: 'Request not found.' } });
});
test('an unchecked LogicModel cannot be approved through HTTP', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_LOGIC_CHECKS'), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: clinicalBody(s) });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'CHECKER_EVIDENCE_REQUIRED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('commit failures return 503 without partial state, audit or approval writes', async t => {
  let fail = false; const db = store({ testFaults: { beforeCommit: () => { if (fail) throw new Error('Fictional private storage detail'); } } });
  const s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), before = await db.listAudit(s.brief.requestId), api = harness(t, db), body = clinicalBody(s);
  fail = true; const r = await api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'), headers: sessionHeaders('clinic'), payload: body }); fail = false;
  assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'SERVICE_UNAVAILABLE'); assert.equal(r.body.includes('private storage'), false);
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await db.listAudit(s.brief.requestId), before); assert.equal(await db.getReceipt(s.brief.requestId, body.eventId), null);
});
test('status storage failures do not leak internal errors', async t => {
  const db = store(), api = harness(t, wrapStore(db, { getWorkflow: async () => { throw new Error('Fictional private database detail'); } }));
  const r = await api.inject({ method: 'GET', url: route('fictional-001', 'status'), headers: sessionHeaders('po') });
  assert.equal(r.statusCode, 503); assert.deepEqual(r.json(), { error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable.' } });
});
for (const boundary of ['authenticate', 'canAccessRequest'] as const) test(`${boundary} failure denies access with 503`, async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING');
  const api = harness(t, db, { authentication: { ...testAuthentication, [boundary]: () => { throw new Error('Fictional identity outage'); } } });
  const r = await api.inject({ method: 'GET', url: route(s.brief.requestId, 'status'), headers: sessionHeaders('po') }); assert.equal(r.statusCode, 503);
});

test('concurrent HTTP approvals cannot advance the same workflow version twice', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), api = harness(t, db), body = clinicalBody(s);
  const results = await Promise.all(['first', 'second'].map(suffix => api.inject({ method: 'POST', url: route(s.brief.requestId, 'clinical-decisions'),
    headers: sessionHeaders('clinic'), payload: { ...body, eventId: `concurrent-${suffix}` } })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version + 1);
  assert.equal((await db.listEvidence(s.brief.requestId)).filter(r => r.kind === 'CLINICAL_DECISION').length, 1);
});
test('concurrent requests retain separate verified principal contexts', async t => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), api = harness(t, db);
  const [allowed, denied] = await Promise.all(['po', 'outsider'].map(who => api.inject({ method: 'GET', url: route(s.brief.requestId, 'status'), headers: sessionHeaders(who) })));
  assert.equal(allowed.statusCode, 200); assert.equal(denied.statusCode, 404);
});
test('authentication is required before malformed JSON is parsed', async t => {
  const db = store(), api = harness(t, db);
  const r = await api.inject({ method: 'POST', url: route('fictional-001', 'clinical-decisions'), headers: { 'content-type': 'application/json' }, payload: '{invalid' });
  assert.equal(r.statusCode, 401);
});
test('no request-creation, callback, dispatch or download endpoints are added', async t => {
  const db = store(), api = harness(t, db);
  for (const url of ['/api/requests', '/api/requests/fictional-001/screening', '/api/requests/fictional-001/dispatch', '/api/requests/fictional-001/download']) {
    const r = await api.inject({ method: 'POST', url, headers: sessionHeaders('po'), payload: {} }); assert.equal(r.statusCode, 404);
  }
});

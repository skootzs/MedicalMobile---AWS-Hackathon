import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createLocalApi } from '../src/server.ts';
import { ApprovalService } from '../src/approvals.ts';
import { ReviewService } from '../src/reviews.ts';
import { at, content } from './helpers/approval-fixtures.ts';
import { reviewFixture, reviewerHeaders, resolveReviewActor, sdState } from './helpers/review-fixtures.ts';
import { wrapStore } from './helpers/api-fixtures.ts';
import { RequestService } from '../src/requests.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';

function harness(t: TestContext, f = reviewFixture()) {
  const api = createLocalApi({ store: f.db, approvals: new ApprovalService({ store: f.db, resolveActor: resolveReviewActor }), reviews: f.reviews, authentication: f.authentication });
  t.after(() => api.close());
  return { ...f, api };
}
const queuePath = (category: string) => `/api/reviews/queue?category=${category}`;
const contextPath = (category: string) => `/api/requests/fictional-001/review-context?category=${category}`;
const cases = [['CLINICAL', 'clinic', 'WAITING_FOR_CLINICAL_APPROVAL'], ['RELEASE', 'release', 'WAITING_FOR_RELEASE_APPROVAL']] as const;
for (const [category, who, status] of cases) test(`HTTP ${category} queue and context expose exact references without private workflow fields`, async t => {
  const f = harness(t), s = await at(f.db, status);
  const queue = await f.api.inject({ method: 'GET', url: queuePath(category), headers: reviewerHeaders(who) });
  assert.equal(queue.statusCode, 200, queue.body); assert.deepEqual(queue.json().items.map((i: { requestId: string }) => i.requestId), ['fictional-001']);
  assert.equal(queue.json().items[0].workflowVersion, s.version); assert.equal(queue.headers['cache-control'], 'no-store');
  const context = await f.api.inject({ method: 'GET', url: `${contextPath(category)}&expectedVersion=${s.version}`, headers: reviewerHeaders(who) });
  assert.equal(context.statusCode, 200, context.body); const c = context.json();
  assert.equal(c.logicModel.snapshotHash, s.logic!.logicHash); assert.deepEqual(c.logicModel.requestPreview, c.request);
  assert.equal(c.eligibility.eligible, true); assert.equal(c.clinicalApprovalRequired, true);
  assert.equal(c.ownerId, undefined); assert.equal(c.processedEvents, undefined); assert.equal(c.roles, undefined); assert.equal(c.contributorIds, undefined);
  assert.equal(c.logicModel.content.sources[0].id, 'fictional-guide');
  if (category === 'RELEASE') { assert.equal(c.decisionReferences.verificationReportHash, s.verification!.reportHash); assert.equal(c.clinicalApproval.actorId, undefined); }
  assert.equal('listen' in f.api, false);
});
for (const [category, who, status] of cases) test(`HTTP ${category} context builds an existing decision request and queue then empties`, async t => {
  const f = harness(t); await at(f.db, status);
  const c = (await f.api.inject({ method: 'GET', url: contextPath(category), headers: reviewerHeaders(who) })).json();
  const url = `/api/requests/fictional-001/${category === 'CLINICAL' ? 'clinical' : 'release'}-decisions`;
  const options = { method: 'POST' as const, url, headers: reviewerHeaders(who), payload: { ...c.decisionReferences, eventId: `http-review-${category}`, decision: 'APPROVE' } };
  const decision = await f.api.inject(options); assert.equal(decision.statusCode, 200, decision.body); assert.equal(decision.json().decision, 'APPROVE');
  const duplicate = await f.api.inject(options); assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.json().duplicate, true);
  const queue = await f.api.inject({ method: 'GET', url: queuePath(category), headers: reviewerHeaders(who) }); assert.deepEqual(queue.json().items, []);
});
for (const url of [queuePath('CLINICAL'), contextPath('CLINICAL')]) test(`missing HTTP authentication blocks ${url}`, async t => {
  const f = harness(t), response = await f.api.inject({ method: 'GET', url }); assert.equal(response.statusCode, 401);
});
test('HTTP roles and actor headers cannot authenticate a reviewer', async t => {
  const f = harness(t), r = await f.api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: { 'x-roles': 'CLINICIAN', 'x-actor-id': 'fictional-clinician', 'x-trusted': 'true' } });
  assert.equal(r.statusCode, 401);
});
test('review endpoints deny by default without an authentication provider', async t => {
  const f = reviewFixture(), api = createLocalApi({ store: f.db, reviews: f.reviews, approvals: new ApprovalService({ store: f.db, resolveActor: resolveReviewActor }) });
  t.after(() => api.close()); const r = await api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: reviewerHeaders('clinic') }); assert.equal(r.statusCode, 401);
});
for (const category of ['SERVICE_DESIGNER', 'CLINICAL', 'RELEASE']) test(`HTTP verified PO cannot impersonate ${category} through query`, async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  for (const url of [queuePath(category), contextPath(category)]) {
    const r = await f.api.inject({ method: 'GET', url, headers: reviewerHeaders('po') }); assert.equal(r.statusCode, 403);
  }
});
test('HTTP outsider clinician receives empty queue and generic inaccessible context 404', async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const queue = await f.api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: reviewerHeaders('outsider') }); assert.equal(queue.statusCode, 200); assert.deepEqual(queue.json().items, []);
  const response = await f.api.inject({ method: 'GET', url: contextPath('CLINICAL'), headers: reviewerHeaders('outsider') });
  assert.equal(response.statusCode, 404); assert.deepEqual(response.json(), { error: { code: 'REQUEST_NOT_FOUND', message: 'Request not found.' } });
});
test('HTTP inaccessible and nonexistent context responses match', async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const denied = await f.api.inject({ method: 'GET', url: contextPath('CLINICAL'), headers: reviewerHeaders('outsider') });
  const missing = await f.api.inject({ method: 'GET', url: '/api/requests/missing/review-context?category=CLINICAL', headers: reviewerHeaders('clinic') });
  assert.equal(missing.statusCode, 404); assert.deepEqual(missing.json(), denied.json());
});
test('HTTP self-approval produces blocked context and no active clinical item', async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await f.api.inject({ method: 'GET', url: contextPath('CLINICAL'), headers: reviewerHeaders('poClinic') });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().eligibility.eligible, false); assert.ok(r.json().eligibility.reasons.includes('SELF_APPROVAL')); assert.equal(r.json().decisionReferences, null);
  const queue = await f.api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: reviewerHeaders('poClinic') }); assert.deepEqual(queue.json().items, []);
});
test('HTTP clinician cannot approve release as separate reviewer', async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_RELEASE_APPROVAL');
  const r = await f.api.inject({ method: 'GET', url: contextPath('RELEASE'), headers: reviewerHeaders('clinicRelease') });
  assert.equal(r.statusCode, 200); assert.equal(r.json().eligibility.eligible, false); assert.ok(r.json().eligibility.reasons.includes('REVIEWER_NOT_INDEPENDENT'));
});
test('HTTP SD context includes current preview, screening findings and route reasons', async t => {
  const f = harness(t), s = await sdState(f.db);
  const queue = await f.api.inject({ method: 'GET', url: queuePath('SERVICE_DESIGNER'), headers: reviewerHeaders('sd') }); assert.equal(queue.json().items.length, 1);
  const response = await f.api.inject({ method: 'GET', url: contextPath('SERVICE_DESIGNER'), headers: reviewerHeaders('sd') });
  assert.equal(response.statusCode, 200, response.body); const c = response.json(); assert.equal(c.preview.snapshotHash, s.brief.snapshotHash);
  assert.equal(c.screening.checks.clinicalSafety.outcome, 'NEEDS_REVIEW'); assert.equal(c.unresolvedFindings[0].area, 'clinicalSafety');
  assert.ok(c.clarification.routingReasons.length > 0); assert.equal(c.clinicalApprovalRequired, true); assert.equal(c.decisionReferences, null);
});
test('HTTP NOT_READY waiting requests never appear in the SD queue', async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_SCREENING');
  const response = await f.api.inject({ method: 'GET', url: queuePath('SERVICE_DESIGNER'), headers: reviewerHeaders('sd') }); assert.equal(response.statusCode, 200); assert.deepEqual(response.json().items, []);
});
test('HTTP current pending context rejects an outdated workflow version with 409', async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const response = await f.api.inject({ method: 'GET', url: `${contextPath('CLINICAL')}&expectedVersion=1`, headers: reviewerHeaders('clinic') });
  assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'VERSION_CONFLICT');
});
test('HTTP completed or wrong-stage review context returns 409', async t => {
  const f = harness(t); await at(f.db, 'CLINICALLY_APPROVED');
  const response = await f.api.inject({ method: 'GET', url: contextPath('CLINICAL'), headers: reviewerHeaders('clinic') }); assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'REVIEW_NOT_PENDING');
});
test('HTTP revised request leaves queue and old approval references fail', async t => {
  const f = harness(t), s = await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const context = (await f.api.inject({ method: 'GET', url: contextPath('CLINICAL'), headers: reviewerHeaders('clinic') })).json();
  const requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  await requests.revise({ ...context.request, expectedVersion: s.version, eventId: 'revised-after-view', content: content(2) }, 'po');
  const queue = await f.api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: reviewerHeaders('clinic') }); assert.deepEqual(queue.json().items, []);
  const decision = await f.api.inject({ method: 'POST', url: '/api/requests/fictional-001/clinical-decisions', headers: reviewerHeaders('clinic'), payload: { ...context.decisionReferences, eventId: 'stale-view-decision', decision: 'APPROVE' } }); assert.equal(decision.statusCode, 409);
});
for (const kind of ['LOGIC_CHECKED', 'VERIFIED'] as const) test(`HTTP missing ${kind} record blocks evidence eligibility`, async t => {
  const f = reviewFixture(); await at(f.db, kind === 'LOGIC_CHECKED' ? 'WAITING_FOR_CLINICAL_APPROVAL' : 'WAITING_FOR_RELEASE_APPROVAL');
  const reviews = new ReviewService({ store: wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).filter(r => r.kind !== kind) }), candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const api = createLocalApi({ store: f.db, reviews, approvals: new ApprovalService({ store: f.db, resolveActor: resolveReviewActor }), authentication: f.authentication }); t.after(() => api.close());
  const who = kind === 'LOGIC_CHECKED' ? 'clinic' : 'release', category = kind === 'LOGIC_CHECKED' ? 'CLINICAL' : 'RELEASE';
  const context = await api.inject({ method: 'GET', url: contextPath(category), headers: reviewerHeaders(who) }); assert.equal(context.statusCode, 200); assert.equal(context.json().eligibility.eligible, false); assert.equal(context.json().decisionReferences, null);
  const queue = await api.inject({ method: 'GET', url: queuePath(category), headers: reviewerHeaders(who) }); assert.deepEqual(queue.json().items, []);
});
for (const suffix of ['', '?category=PO', '?category=CLINICAL&actorId=someone', '?category=CLINICAL&roles=CLINICIAN', '?category=CLINICAL&trusted=true', '?category=CLINICAL&category=RELEASE', '?category=CLINICAL&expectedVersion=7']) test(`queue query rejects ${suffix || 'missing category'}`, async t => {
  const f = harness(t), r = await f.api.inject({ method: 'GET', url: '/api/reviews/queue' + suffix, headers: reviewerHeaders('clinic') }); assert.equal(r.statusCode, 400);
});
for (const suffix of ['', '?category=PO', '?category=CLINICAL&expectedVersion=0', '?category=CLINICAL&expectedVersion=-1', '?category=CLINICAL&expectedVersion=1.5', '?category=CLINICAL&expectedVersion=9007199254740992', '?category=CLINICAL&actorId=someone']) test(`context query rejects ${suffix || 'missing category'}`, async t => {
  const f = harness(t); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await f.api.inject({ method: 'GET', url: '/api/requests/fictional-001/review-context' + suffix, headers: reviewerHeaders('clinic') }); assert.equal(r.statusCode, 400);
});
test('HTTP candidate-source errors return sanitized 503', async t => {
  const f = harness(t, reviewFixture({ candidates: { listReviewCandidates: async () => { throw Error('private database credentials'); } } }));
  const r = await f.api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: reviewerHeaders('clinic') }); assert.equal(r.statusCode, 503); assert.equal(r.body.includes('private'), false);
});
test('HTTP queue and context reads have no audit or workflow side effects', async t => {
  const f = harness(t), s = await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'), before = await f.db.listAudit('fictional-001');
  await f.api.inject({ method: 'GET', url: queuePath('CLINICAL'), headers: reviewerHeaders('clinic') });
  await f.api.inject({ method: 'GET', url: contextPath('CLINICAL'), headers: reviewerHeaders('clinic') });
  assert.deepEqual(await f.db.getWorkflow('fictional-001'), s); assert.deepEqual(await f.db.listAudit('fictional-001'), before);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewService } from '../src/reviews.ts';
import type { ReviewCategory, ReviewContext } from '../src/reviews.ts';
import { ApprovalService } from '../src/approvals.ts';
import type { ApprovalCommand } from '../src/approvals.ts';
import { canonicalizeJson } from '../src/snapshots.ts';
import { RequestService } from '../src/requests.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';
import { at, content } from './helpers/approval-fixtures.ts';
import { wrapStore } from './helpers/api-fixtures.ts';
import { reviewFixture, resolveReviewActor, sdState } from './helpers/review-fixtures.ts';

const cases = [['CLINICAL', 'clinic', 'WAITING_FOR_CLINICAL_APPROVAL'], ['RELEASE', 'release', 'WAITING_FOR_RELEASE_APPROVAL']] as const;
function value(result: Awaited<ReturnType<ReviewService['context']>>): ReviewContext {
  assert.equal(result.status, 'SUCCESS', JSON.stringify(result)); if (result.status !== 'SUCCESS') throw Error('fixture'); return result.context;
}
for (const [category, who, status] of cases) test(`${category} queue finds eligible work and exact current context`, async () => {
  const f = reviewFixture(), s = await at(f.db, status), queue = await f.reviews.queue(category, who);
  assert.equal(queue.status, 'SUCCESS'); if (queue.status !== 'SUCCESS') throw Error('fixture');
  assert.deepEqual(queue.items.map(i => i.requestId), ['fictional-001']); assert.equal(queue.items[0].workflowVersion, s.version);
  const c = value(await f.reviews.context('fictional-001', category, who, s.version)); assert.equal(c.eligibility.eligible, true);
  assert.equal(c.logicModel!.snapshotHash, s.logic!.logicHash); assert.equal(c.logicModel!.revision, s.logic!.logicRevision);
  assert.equal(c.decisionReferences!.requestSnapshotHash, s.brief.snapshotHash); assert.equal(c.checker!.reportId, s.checks!.reportId);
  assert.equal(c.clinicalApprovalRequired, true); assert.equal(c.preview, null);
  if (category === 'RELEASE') { assert.equal(c.clinicalApproval!.eventId, s.clinicalApproval!.eventId); assert.equal(c.artifact!.artifactHash, s.artifact!.artifactHash); assert.equal(c.verification!.reportHash, s.verification!.reportHash); }
});
for (const [category, who, status] of cases) test(`${category} context references build a valid existing approval command`, async () => {
  const f = reviewFixture(); await at(f.db, status); const c = value(await f.reviews.context('fictional-001', category, who));
  const service = new ApprovalService({ store: f.db, resolveActor: resolveReviewActor });
  const approval = { ...c.decisionReferences, requestId: c.requestId, eventId: `review-decision-${category}`, type: category === 'CLINICAL' ? 'CLINICAL_DECISION' : 'RELEASE_DECISION', decision: 'APPROVE' } as ApprovalCommand;
  assert.equal((await service.execute(approval, who)).status, 'SUCCESS');
  assert.equal((await service.execute(approval, who)).status, 'DUPLICATE_EVENT');
  const queue = await f.reviews.queue(category, who); assert.equal(queue.status, 'SUCCESS'); if (queue.status === 'SUCCESS') assert.deepEqual(queue.items, []);
  assert.equal((await f.reviews.context(c.requestId, category, who)).status, 'STALE');
});
for (const who of ['poClinic', 'contributorClinician']) test(`${who} can inspect visible clinical context but cannot enter an eligible queue`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); const c = value(await f.reviews.context('fictional-001', 'CLINICAL', who));
  assert.equal(c.eligibility.eligible, false); assert.ok(c.eligibility.reasons.includes('SELF_APPROVAL')); assert.equal(c.decisionReferences, null);
  const r = await f.reviews.queue('CLINICAL', who); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
test('clinician cannot separately release the artifact they clinically approved', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_RELEASE_APPROVAL'); const c = value(await f.reviews.context('fictional-001', 'RELEASE', 'clinicRelease'));
  assert.equal(c.eligibility.eligible, false); assert.ok(c.eligibility.reasons.includes('REVIEWER_NOT_INDEPENDENT'));
  const r = await f.reviews.queue('RELEASE', 'clinicRelease'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
for (const category of ['SERVICE_DESIGNER', 'CLINICAL', 'RELEASE'] as const) test(`PO cannot select ${category} to acquire a reviewer role`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  assert.equal((await f.reviews.queue(category, 'po')).status, 'FORBIDDEN'); assert.equal((await f.reviews.context('fictional-001', category, 'po')).status, 'FORBIDDEN');
});
test('unauthorized clinician sees no other request and causes no private record reads', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let reads = 0;
  const facade = wrapStore(f.db, { getWorkflow: async id => { reads++; return f.db.getWorkflow(id); }, listEvidence: async id => { reads++; return f.db.listEvidence(id); } });
  const service = new ReviewService({ store: facade, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  assert.equal((await service.context('fictional-001', 'CLINICAL', 'outsider')).status, 'NOT_FOUND');
  const r = await service.queue('CLINICAL', 'outsider'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []); assert.equal(reads, 0);
});
test('missing and inaccessible request contexts match without exposing metadata', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  assert.deepEqual(await f.reviews.context('missing', 'CLINICAL', 'clinic'), await f.reviews.context('fictional-001', 'CLINICAL', 'outsider'));
});
test('SD sees only legitimate current escalations with screening and clarification findings', async () => {
  const f = reviewFixture(), s = await sdState(f.db), r = await f.reviews.queue('SERVICE_DESIGNER', 'sd');
  if (r.status !== 'SUCCESS') throw Error('fixture'); assert.equal(r.items.length, 1);
  const c = value(await f.reviews.context('fictional-001', 'SERVICE_DESIGNER', 'sd'));
  assert.equal(c.preview!.snapshotHash, s.brief.snapshotHash); assert.equal(c.screening!.screeningId, s.screening!.screeningId);
  assert.equal(c.unresolvedFindings[0].area, 'clinicalSafety'); assert.ok(c.clarification!.routingReasons.length > 0);
  assert.equal(c.logicModel, null); assert.equal(c.decisionReferences, null); assert.equal(c.eligibility.eligible, true);
});
for (const status of ['WAITING_FOR_SCREENING', 'WAITING_FOR_PO_CONFIRMATION', 'READY_TO_ROUTE'] as const) test(`${status}/NOT_READY is not an SD task`, async () => {
  const f = reviewFixture(); await at(f.db, status); const r = await f.reviews.queue('SERVICE_DESIGNER', 'sd');
  if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
test('stale candidate source cannot turn NOT_READY into an SD task', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_SCREENING');
  const service = new ReviewService({ store: f.db, candidates: { listReviewCandidates: async () => ['fictional-001'] }, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const r = await service.queue('SERVICE_DESIGNER', 'sd'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
test('SD is excluded when stored routing is NOT_READY even if pending state is inconsistent', async () => {
  const f = reviewFixture(); await sdState(f.db);
  const store = wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s ? { ...s, routing: { ...s.routing!, route: 'NOT_READY' } } : null; } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const c = value(await service.context('fictional-001', 'SERVICE_DESIGNER', 'sd')); assert.equal(c.eligibility.eligible, false); assert.ok(c.eligibility.reasons.includes('SD_ROUTING_REQUIRED'));
  const r = await service.queue('SERVICE_DESIGNER', 'sd'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
for (const category of ['CLINICAL', 'RELEASE'] as const) test(`${category} missing checker record blocks queue and context eligibility`, async () => {
  const f = reviewFixture(); await at(f.db, category === 'CLINICAL' ? 'WAITING_FOR_CLINICAL_APPROVAL' : 'WAITING_FOR_RELEASE_APPROVAL');
  const store = wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).filter(r => r.kind !== 'LOGIC_CHECKED') });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest }); const who = category === 'CLINICAL' ? 'clinic' : 'release';
  const c = value(await service.context('fictional-001', category, who)); assert.equal(c.eligibility.eligible, false); assert.ok(c.eligibility.reasons.includes('CHECKER_EVIDENCE_REQUIRED')); assert.equal(c.decisionReferences, null);
  const r = await service.queue(category, who); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
for (const changes of ['missing', 'failed', 'stale'] as const) test(`${changes} checker state blocks clinical eligibility`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const store = wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); if (!s) return null;
    return { ...s, checks: changes === 'missing' ? null : { ...s.checks!, ...(changes === 'failed' ? { passed: false } : { logicHash: 'e'.repeat(64) }) } }; } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  assert.equal(value(await service.context('fictional-001', 'CLINICAL', 'clinic')).eligibility.eligible, false);
});
for (const kind of ['CLINICAL_DECISION', 'COMPILED', 'VERIFIED'] as const) test(`release requires authoritative ${kind} record`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_RELEASE_APPROVAL');
  const store = wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).filter(r => r.kind !== kind) });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const c = value(await service.context('fictional-001', 'RELEASE', 'release')); assert.equal(c.eligibility.eligible, false); assert.equal(c.decisionReferences, null);
});
for (const changes of ['missing', 'failed', 'artifactMismatch'] as const) test(`${changes} verification blocks release eligibility`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_RELEASE_APPROVAL');
  const store = wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); if (!s) return null;
    return { ...s, verification: changes === 'missing' ? null : { ...s.verification!, ...(changes === 'failed' ? { passed: false } : { artifactHash: 'e'.repeat(64) }) } }; } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const c = value(await service.context('fictional-001', 'RELEASE', 'release')); assert.equal(c.eligibility.eligible, false);
  const r = await service.queue('RELEASE', 'release'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
for (const [category, who, status] of cases) test(`revised ${category} disappears and old decision references remain blocked`, async () => {
  const f = reviewFixture(), s = await at(f.db, status); const c = value(await f.reviews.context('fictional-001', category, who));
  const requests = new RequestService({ store: f.db, resolveActor: resolveReviewActor, validateSnapshot: provisionalSnapshotValidator });
  await requests.revise({ ...c.request, expectedVersion: s.version, eventId: 'material-revision', content: content(2) }, 'po');
  const r = await f.reviews.queue(category, who); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
  assert.equal((await f.reviews.context('fictional-001', category, who, c.workflowVersion)).status, 'STALE');
  const approvals = new ApprovalService({ store: f.db, resolveActor: resolveReviewActor });
  const old = { ...c.decisionReferences, requestId: c.requestId, eventId: 'stale-review-decision', type: category === 'CLINICAL' ? 'CLINICAL_DECISION' : 'RELEASE_DECISION', decision: 'APPROVE' } as ApprovalCommand;
  assert.equal((await approvals.execute(old, who)).status, 'STALE_VERSION');
});
for (const decision of ['REJECT', 'RETURN'] as const) test(`${decision} clinical reviews leave active queue`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); const c = value(await f.reviews.context('fictional-001', 'CLINICAL', 'clinic'));
  const service = new ApprovalService({ store: f.db, resolveActor: resolveReviewActor });
  await service.execute({ ...c.decisionReferences, requestId: c.requestId, eventId: `decision-${decision}`, type: 'CLINICAL_DECISION', decision, note: 'Fictional correction required.' } as ApprovalCommand, 'clinic');
  const r = await f.reviews.queue('CLINICAL', 'clinic'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
test('queue/context reads do not change workflows, snapshots, receipts, evidence or audits', async () => {
  const f = reviewFixture(), s = await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const before = { state: s, snapshots: await f.db.listSnapshots('fictional-001'), evidence: await f.db.listEvidence('fictional-001'), audit: await f.db.listAudit('fictional-001') };
  await f.reviews.queue('CLINICAL', 'clinic'); await f.reviews.context('fictional-001', 'CLINICAL', 'clinic');
  const after = { state: await f.db.getWorkflow('fictional-001'), snapshots: await f.db.listSnapshots('fictional-001'), evidence: await f.db.listEvidence('fictional-001'), audit: await f.db.listAudit('fictional-001') };
  assert.equal(canonicalizeJson(before), canonicalizeJson(after)); assert.equal(await f.db.getReceipt('fictional-001', 'review-read-probe-0'), null);
});
test('candidate enumeration is read-only, detached, and filters current states', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const ids = await f.db.listReviewCandidates('WAITING_FOR_CLINICAL_APPROVAL'); (ids as string[]).push('invented');
  assert.deepEqual(await f.db.listReviewCandidates('WAITING_FOR_CLINICAL_APPROVAL'), ['fictional-001']); assert.deepEqual(await f.db.listReviewCandidates('NEEDS_SD_REVIEW'), []);
});
test('context detects concurrent workflow change during evidence reads', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let reads = 0;
  const store = wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s && ++reads > 1 ? { ...s, version: s.version + 1 } : s; } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  assert.equal((await service.context('fictional-001', 'CLINICAL', 'clinic')).status, 'STALE');
});
test('revoked request visibility during context construction hides existence', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let checks = 0;
  const service = new ReviewService({ store: f.db, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: () => ++checks === 1 });
  assert.equal((await service.context('fictional-001', 'CLINICAL', 'clinic')).status, 'NOT_FOUND');
});
test('role revocation during context construction rejects access', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let checks = 0;
  const service = new ReviewService({ store: f.db, candidates: f.db, resolveActor: () => ++checks === 1 ? resolveReviewActor('clinic') : resolveReviewActor('po'), canAccessRequest: f.canAccessRequest });
  assert.equal((await service.context('fictional-001', 'CLINICAL', 'clinic')).status, 'FORBIDDEN');
});
test('server policy can exclude assigned work without inventing assignments', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const service = new ReviewService({ store: f.db, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: () => false });
  const r = await service.queue('CLINICAL', 'clinic'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
test('duplicate candidate IDs do not duplicate review items', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const service = new ReviewService({ store: f.db, candidates: { listReviewCandidates: async () => ['fictional-001', 'fictional-001'] }, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const r = await service.queue('CLINICAL', 'clinic'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.equal(r.items.length, 1);
});
for (const category of ['UNKNOWN', 'PO', 'clinician']) test(`service rejects invalid category ${category}`, async () => {
  const f = reviewFixture(); assert.equal((await f.reviews.queue(category as ReviewCategory, 'clinic')).status, 'INVALID_INPUT');
});
for (const version of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) test(`context rejects invalid expected version ${version}`, async () => {
  const f = reviewFixture(); assert.equal((await f.reviews.context('fictional-001', 'CLINICAL', 'clinic', version)).status, 'INVALID_INPUT');
});
test('candidate-source failure returns no partial queue', async () => {
  const f = reviewFixture({ candidates: { listReviewCandidates: async () => { throw Error('private index'); } } });
  assert.equal((await f.reviews.queue('CLINICAL', 'clinic')).status, 'STORAGE_FAILURE');
});
test('missing trusted visibility policy is never defaulted to allow', () => {
  assert.throws(() => new ReviewService({} as never));
});

test('queue role check precedes discovery and rejects unknown identity without enumeration', async () => {
  let calls = 0; const f = reviewFixture({ candidates: { listReviewCandidates: async () => { calls++; return []; } } });
  assert.equal((await f.reviews.queue('CLINICAL', 'unknown')).status, 'FORBIDDEN'); assert.equal(calls, 0);
});
for (const kind of ['SCREENING_COMPLETED', 'PO_DECISION'] as const) test(`SD context requires authoritative ${kind} evidence`, async () => {
  const f = reviewFixture(); await sdState(f.db);
  const store = wrapStore(f.db, { listEvidence: async id => (await f.db.listEvidence(id)).filter(r => r.kind !== kind) });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const c = value(await service.context('fictional-001', 'SERVICE_DESIGNER', 'sd')); assert.equal(c.eligibility.eligible, false); assert.ok(c.eligibility.reasons.includes('INTAKE_EVIDENCE_REQUIRED'));
  const queue = await service.queue('SERVICE_DESIGNER', 'sd'); if (queue.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(queue.items, []);
});
for (const kind of ['REQUEST_PREVIEW', 'LOGIC_MODEL'] as const) test(`missing ${kind} snapshot blocks clinical eligibility`, async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const store = wrapStore(f.db, { getSnapshot: async key => key.kind === kind ? null : f.db.getSnapshot(key) });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const c = value(await service.context('fictional-001', 'CLINICAL', 'clinic')); assert.equal(c.eligibility.eligible, false); assert.ok(c.eligibility.reasons.includes('SNAPSHOT_REQUIRED')); assert.equal(c.decisionReferences, null);
});
test('cross-request LogicModel content from a broken adapter is never exposed', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const store = wrapStore(f.db, { getSnapshot: async key => { const s = await f.db.getSnapshot(key); return s && key.kind === 'LOGIC_MODEL' ? { ...s, requestId: 'private-other-request', content: { privateMarker: 'must-not-expose' } } : s; } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const c = value(await service.context('fictional-001', 'CLINICAL', 'clinic')); assert.equal(c.logicModel, null); assert.equal(c.eligibility.eligible, false); assert.equal(JSON.stringify(c).includes('must-not-expose'), false);
});
test('cross-request workflow state from a broken adapter fails before private snapshot reads', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let reads = 0;
  const store = wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s ? { ...s, brief: { ...s.brief, requestId: 'private-other-request' } } : s; },
    getSnapshot: async key => { reads++; return f.db.getSnapshot(key); } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  assert.equal((await service.context('fictional-001', 'CLINICAL', 'clinic')).status, 'STORAGE_FAILURE'); assert.equal(reads, 0);
});
test('evidence read failure yields storage failure instead of eligible or partial queue', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const store = wrapStore(f.db, { listEvidence: async () => { throw Error('private report storage'); } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  assert.equal((await service.queue('CLINICAL', 'clinic')).status, 'STORAGE_FAILURE'); assert.equal((await service.context('fictional-001', 'CLINICAL', 'clinic')).status, 'STORAGE_FAILURE');
});
test('unknown assignment policy is not fabricated in returned queue or context', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const c = value(await f.reviews.context('fictional-001', 'CLINICAL', 'clinic')); assert.equal('assignee' in c, false); assert.equal('assignedTo' in c, false);
});
test('multiple candidates return only visible current-category work without hidden totals', async () => {
  const { submit, next } = await import('./helpers/approval-fixtures.ts');
  const f = reviewFixture();
  for (const [id, target] of [['fictional-001', 'WAITING_FOR_CLINICAL_APPROVAL'], ['fictional-private', 'WAITING_FOR_CLINICAL_APPROVAL'], ['fictional-release', 'WAITING_FOR_RELEASE_APPROVAL']] as const) {
    assert.equal((await f.db.apply(submit(1, id), 'po')).outcome, 'ACCEPTED'); let s = (await f.db.getWorkflow(id))!;
    while (s.status !== target) { const step = next(s); assert.equal((await f.db.apply(step.cmd, step.who)).outcome, 'ACCEPTED'); s = (await f.db.getWorkflow(id))!; }
  }
  f.visibility.set('fictional-release', new Set(['release']));
  const clinical = await f.reviews.queue('CLINICAL', 'clinic'); if (clinical.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(clinical.items.map(i => i.requestId), ['fictional-001']); assert.equal('totalCandidates' in clinical, false);
  const release = await f.reviews.queue('RELEASE', 'release'); if (release.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(release.items.map(i => i.requestId), ['fictional-release']);
});
test('role changes while queue is being built cannot return a queue under another actor', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let scopes = 0;
  const service = new ReviewService({ store: f.db, candidates: f.db, canAccessRequest: f.canAccessRequest,
    resolveActor: (principal, scope) => scope === 'review-queue' && ++scopes > 1 ? resolveReviewActor('outsider') : resolveReviewActor(principal) });
  assert.equal((await service.queue('CLINICAL', 'clinic')).status, 'FORBIDDEN');
});

test('queue rechecks visibility before publishing assembled items', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let checks = 0;
  const service = new ReviewService({ store: f.db, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: () => ++checks <= 2 });
  const r = await service.queue('CLINICAL', 'clinic'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});
test('queue drops a candidate whose workflow changes after context construction', async () => {
  const f = reviewFixture(); await at(f.db, 'WAITING_FOR_CLINICAL_APPROVAL'); let reads = 0;
  const store = wrapStore(f.db, { getWorkflow: async id => { const s = await f.db.getWorkflow(id); return s && ++reads > 2 ? { ...s, version: s.version + 1 } : s; } });
  const service = new ReviewService({ store, candidates: f.db, resolveActor: resolveReviewActor, canAccessRequest: f.canAccessRequest });
  const r = await service.queue('CLINICAL', 'clinic'); if (r.status !== 'SUCCESS') throw Error('fixture'); assert.deepEqual(r.items, []);
});

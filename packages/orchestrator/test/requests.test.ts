import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestService } from '../src/requests.ts';
import type { CurrentRequestCommand, RequestResult, CreateRequestCommand } from '../src/requests.ts';
import { provisionalSnapshotValidator } from '../src/snapshots.ts';
import { routeDesignBrief } from '../src/routing.ts';
import type { WorkflowState } from '../src/workflow.ts';
import { requestFixture, mockRole3, resolveRequestActor } from './helpers/request-fixtures.ts';
import { content, at } from './helpers/approval-fixtures.ts';
import { wrapStore } from './helpers/api-fixtures.ts';

const creation = (eventId = 'fictional-create-1') => ({ eventId, expectedVersion: 0 as const, content: content() });
function current(s: WorkflowState, eventId: string): CurrentRequestCommand {
  return { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash, expectedVersion: s.version, eventId };
}
async function created() {
  const f = requestFixture(), r = await f.service.create(creation(), 'po'); assert.equal(r.status, 'SUCCESS');
  return { ...f, s: (await f.db.getWorkflow(r.requestId!))! };
}
async function screened() {
  const f = await created(); const r = await mockRole3(f.service).screen(current(f.s, 'screen-event')); assert.equal(r.status, 'SUCCESS', r.reason);
  return { ...f, s: (await f.db.getWorkflow(f.s.brief.requestId))! };
}
const confirmation = (s: WorkflowState, eventId = 'confirm-event') => ({ ...current(s, eventId), screeningId: s.screening?.screeningId ?? 'not-screened', decision: 'CONFIRMED' as const });
const accepted = (r: RequestResult) => assert.equal(r.status, 'SUCCESS', r.reason);

test('PO creates a server-identified request with version one and immutable preview', async () => {
  const { db, s } = await created(); assert.match(s.brief.requestId, /^req-[a-f0-9]{64}$/);
  assert.equal(s.version, 1); assert.equal(s.brief.revision, 1); assert.equal(s.ownerId, 'fictional-po'); assert.equal(s.status, 'WAITING_FOR_SCREENING');
  assert.equal((await db.listSnapshots(s.brief.requestId)).length, 1); assert.equal((await db.listAudit(s.brief.requestId)).length, 1);
});
for (const principal of ['clinic', 'ai', 'release', 'unknown']) test(`${principal} cannot create a PO request`, async () => {
  const f = requestFixture(), r = await f.service.create(creation(), principal); assert.equal(r.status, 'REJECTED');
  assert.equal(r.requestId, null); assert.equal(r.reason, principal === 'unknown' ? 'UNAUTHORIZED' : 'WRONG_ROLE');
});
test('same submission key from different verified POs creates distinct backend IDs', async () => {
  const f = requestFixture(); const a = await f.service.create(creation(), 'po'), b = await f.service.create(creation(), 'po2');
  accepted(a); accepted(b); assert.notEqual(a.requestId, b.requestId);
});
test('same owner with separate submission event keys creates separate requests', async () => {
  const f = requestFixture(); const a = await f.service.create(creation('one'), 'po'), b = await f.service.create(creation('two'), 'po');
  accepted(a); accepted(b); assert.notEqual(a.requestId, b.requestId);
});
test('duplicate creation works across fresh service instances sharing storage', async () => {
  const f = await created(); const service = new RequestService({ store: f.db, resolveActor: resolveRequestActor, validateSnapshot: provisionalSnapshotValidator });
  const r = await service.create(creation(), 'po'); assert.equal(r.status, 'DUPLICATE_EVENT'); assert.equal(r.requestId, f.s.brief.requestId);
  assert.equal((await f.db.getWorkflow(r.requestId!))!.version, 1); assert.equal((await f.db.listSnapshots(r.requestId!)).length, 1);
  assert.equal((await f.db.listAudit(r.requestId!)).filter(a => a.outcome === 'ACCEPTED').length, 1);
});
test('changed creation content under the same submission key conflicts', async () => {
  const f = await created(), r = await f.service.create({ ...creation(), content: content(2) }, 'po'); assert.equal(r.reason, 'EVENT_ID_REUSED');
  assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('concurrent duplicate creations persist one request, snapshot and transition', async () => {
  const f = requestFixture(), results = await Promise.all([f.service.create(creation(), 'po'), f.service.create(creation(), 'po')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['DUPLICATE_EVENT', 'SUCCESS']); assert.equal(results[0].requestId, results[1].requestId);
  assert.equal((await f.db.getWorkflow(results[0].requestId!))!.version, 1);
});
test('concurrent conflicting creations cannot overwrite the winning content', async () => {
  const f = requestFixture(), results = await Promise.all([f.service.create(creation(), 'po'), f.service.create({ ...creation(), content: content(2) }, 'po')]);
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 1); assert.equal(results.filter(r => r.reason === 'EVENT_ID_REUSED').length, 1);
  assert.equal((await f.db.listSnapshots(results[0].requestId!)).length, 1);
});
test('owner retrieves current content and snapshot metadata without approval claims', async () => {
  const f = await created(), r = await f.service.get(f.s.brief.requestId, 'po'); assert.equal(r.status, 'SUCCESS');
  if (r.status !== 'SUCCESS') throw Error('fixture'); assert.equal(r.request.preview.snapshotHash, f.s.brief.snapshotHash);
  assert.equal(r.request.clinicalApprovalRequired, true); assert.equal(r.request.screening, null);
});
for (const who of ['po2', 'clinic', 'unknown']) test(`${who} cannot retrieve the owner-only intake view`, async () => {
  const f = await created(); assert.deepEqual(await f.service.get(f.s.brief.requestId, who), { status: 'NOT_FOUND' });
});
test('missing request is indistinguishable from inaccessible request in retrieval', async () => {
  const f = requestFixture(); assert.deepEqual(await f.service.get('missing', 'po'), { status: 'NOT_FOUND' });
});
test('trusted R3 screening records all five assessments without routing', async () => {
  const f = await screened(); assert.equal(f.s.status, 'WAITING_FOR_PO_CONFIRMATION'); assert.equal(f.s.routing, null);
  assert.equal(Object.keys(f.s.screening!.checks).length, 5); assert.equal((await f.db.listEvidence(f.s.brief.requestId))[0].kind, 'SCREENING_COMPLETED');
});
for (const status of ['PENDING', 'FAILED'] as const) test(`${status} screening cannot advance the request`, async () => {
  const f = await created(), r = await mockRole3(f.service).screen(current(f.s, 'screen'), { status });
  assert.equal(r.reason, 'SCREENING_NOT_READY'); assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('PO/browser context cannot assert authoritative screening', async () => {
  const f = await created(), cmd = { ...current(f.s, 'screen'), screening: {
    ...current(f.s, 'ignored'), screeningId: 'fake', status: 'COMPLETED' as const, checks: {} as never,
  } };
  const r = await f.service.recordScreening(cmd, 'po'); assert.equal(r.reason, 'INVALID_COMMAND');
  assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('wrong-role actor cannot submit structurally valid R3 screening', async () => {
  const f = await screened(); const r = await f.service.recordScreening({ ...current(f.s, 'screen-spoof'), screening: f.s.screening! }, 'po');
  assert.equal(r.reason, 'WRONG_ROLE'); assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('confirmation before completed screening is blocked', async () => {
  const f = await created(), r = await f.service.confirm(confirmation(f.s), 'po'); assert.equal(r.reason, 'WRONG_STATE');
  assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('current PO confirmation reaches READY_TO_ROUTE and does not dispatch anything', async () => {
  const f = await screened(); accepted(await f.service.confirm(confirmation(f.s), 'po'));
  const s = (await f.db.getWorkflow(f.s.brief.requestId))!; assert.equal(s.status, 'READY_TO_ROUTE'); assert.equal(s.routing, null);
  assert.equal(s.logic, null); assert.equal(s.clinicalApproval, null); assert.equal(s.releaseApproval, null);
  assert.equal(s.confirmation!.snapshotHash, s.brief.snapshotHash); assert.equal(s.confirmation!.screeningId, s.screening!.screeningId);
});
for (const changes of [{ revision: 2 }, { snapshotHash: 'f'.repeat(64) }, { expectedVersion: 1 }, { screeningId: 'old-screen' }]) test(`confirmation rejects stale ${Object.keys(changes)[0]}`, async () => {
  const f = await screened(), r = await f.service.confirm({ ...confirmation(f.s), ...changes }, 'po');
  assert.ok(['STALE_REQUEST', 'VERSION_CONFLICT', 'INVALID_CONFIRMATION'].includes(r.reason), r.reason);
  assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
for (const who of ['po2', 'clinic']) test(`${who} cannot confirm another PO request`, async () => {
  const f = await screened(), r = await f.service.confirm(confirmation(f.s), who); assert.ok(['WRONG_OWNER', 'WRONG_ROLE'].includes(r.reason));
  assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('duplicate confirmation records one PO decision and one transition', async () => {
  const f = await screened(), c = confirmation(f.s); accepted(await f.service.confirm(c, 'po'));
  assert.equal((await f.service.confirm(c, 'po')).status, 'DUPLICATE_EVENT');
  assert.equal((await f.db.getWorkflow(c.requestId))!.version, f.s.version + 1);
  assert.equal((await f.db.listEvidence(c.requestId)).filter(r => r.kind === 'PO_DECISION').length, 1);
});
test('changed decision using an accepted confirmation event ID is a conflict', async () => {
  const f = await screened(), c = confirmation(f.s); accepted(await f.service.confirm(c, 'po'));
  assert.equal((await f.service.confirm({ ...c, decision: 'REVISION_REQUESTED' }, 'po')).reason, 'EVENT_ID_REUSED');
});
test('concurrent different PO decisions advance the same version only once', async () => {
  const f = await screened(); const results = await Promise.all(['a', 'b'].map(event => f.service.confirm(confirmation(f.s, event), 'po')));
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 1); assert.equal(results.filter(r => r.status === 'STALE_VERSION').length, 1);
});
test('correction request then material revision requires new screening and confirmation', async () => {
  const f = await screened(); accepted(await f.service.confirm({ ...confirmation(f.s), decision: 'REVISION_REQUESTED' }, 'po'));
  const returned = (await f.db.getWorkflow(f.s.brief.requestId))!; assert.equal(returned.status, 'RETURNED_FOR_CLARIFICATION');
  accepted(await f.service.revise({ ...current(returned, 'revision'), content: content(2) }, 'po'));
  const revised = (await f.db.getWorkflow(f.s.brief.requestId))!; assert.equal(revised.brief.revision, 2); assert.equal(revised.status, 'WAITING_FOR_SCREENING');
  assert.equal(revised.screening, null); assert.equal(revised.confirmation, null); assert.equal(revised.routing, null);
  assert.equal((await f.db.listSnapshots(revised.brief.requestId)).length, 2);
  assert.equal((await f.db.listEvidence(revised.brief.requestId)).length, 2);
  assert.equal((await f.service.confirm({ ...confirmation(revised, 'confirm-before-rescreen'), screeningId: f.s.screening!.screeningId }, 'po')).reason, 'WRONG_STATE');
  accepted(await mockRole3(f.service).screen(current(revised, 'rescreen')));
  const rescreened = (await f.db.getWorkflow(f.s.brief.requestId))!; accepted(await f.service.confirm(confirmation(rescreened, 'reconfirm'), 'po'));
});
test('unchanged content cannot manufacture a material revision merely by hashing new metadata', async () => {
  const f = await created(), r = await f.service.revise({ ...current(f.s, 'no-change'), content: content() }, 'po');
  assert.equal(r.reason, 'NO_MATERIAL_CHANGE'); assert.equal((await f.db.listSnapshots(f.s.brief.requestId)).length, 1);
});
test('reordered JSON keys are unchanged content', async () => {
  const f = await created(), c = content(); const r = await f.service.revise({ ...current(f.s, 'no-change'), content: {
    requirements: c.requirements, targetPopulation: c.targetPopulation, objective: c.objective, title: c.title,
  } }, 'po'); assert.equal(r.reason, 'NO_MATERIAL_CHANGE');
});
test('stale and conflicting concurrent revisions cannot overwrite snapshots', async () => {
  const f = await created(), results = await Promise.all([2, 3].map(n => f.service.revise({ ...current(f.s, `rev-${n}`), content: content(n) }, 'po')));
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 1); assert.equal(results.filter(r => r.status === 'STALE_VERSION').length, 1);
  const history = await f.db.listSnapshots(f.s.brief.requestId); assert.equal(history.length, 2); assert.equal(history[0].snapshotHash, f.s.brief.snapshotHash);
});
test('revision retry after later content changes remains duplicate and never restores superseded confirmation', async () => {
  const f = await screened(); accepted(await f.service.confirm(confirmation(f.s), 'po'));
  let s = (await f.db.getWorkflow(f.s.brief.requestId))!; const rev = { ...current(s, 'rev-2'), content: content(2) };
  accepted(await f.service.revise(rev, 'po')); s = (await f.db.getWorkflow(s.brief.requestId))!;
  accepted(await f.service.revise({ ...current(s, 'rev-3'), content: content(3) }, 'po'));
  const before = await f.db.getWorkflow(s.brief.requestId); assert.equal((await f.service.revise(rev, 'po')).status, 'DUPLICATE_EVENT');
  assert.equal((await f.service.confirm(confirmation(f.s), 'po')).status, 'DUPLICATE_EVENT');
  assert.deepEqual(await f.db.getWorkflow(s.brief.requestId), before);
});
test('late screening for superseded preview is rejected', async () => {
  const f = await created(); accepted(await f.service.revise({ ...current(f.s, 'rev'), content: content(2) }, 'po'));
  assert.equal((await mockRole3(f.service).screen(current(f.s, 'late-screen'))).status, 'STALE_VERSION');
});
test('R3 can revise its interpretation before screening and PO confirms that new preview', async () => {
  const f = await created(); accepted(await mockRole3(f.service).interpret({ ...current(f.s, 'ai-interpretation'), content: content(2) }));
  const revised = (await f.db.getWorkflow(f.s.brief.requestId))!; accepted(await mockRole3(f.service).screen(current(revised, 'screen-interpretation')));
  const s = (await f.db.getWorkflow(f.s.brief.requestId))!; accepted(await f.service.confirm(confirmation(s), 'po'));
  assert.equal((await f.db.getWorkflow(s.brief.requestId))!.confirmation!.snapshotHash, revised.brief.snapshotHash);
});
test('R3 cannot silently replace an interpretation that is awaiting PO confirmation', async () => {
  const f = await screened(); const r = await f.service.reviseInterpretation({ ...current(f.s, 'ai-overwrite'), content: content(2) }, 'ai');
  assert.equal(r.reason, 'WRONG_ROLE'); assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('PO cannot use the internal interpretation adapter as a DRAFTER', async () => {
  const f = await created(), r = await f.service.reviseInterpretation({ ...current(f.s, 'spoof'), content: content(2) }, 'po'); assert.equal(r.reason, 'WRONG_ROLE');
});
test('clinical concern remains for SD/clinical review even after PO confirmation', async () => {
  const f = await created(); const r = await mockRole3(f.service).screen(current(f.s, 'concern'), { checks: {
    completeness: { outcome: 'CLEAR', reasons: [] }, ambiguities: { outcome: 'CLEAR', reasons: [] }, contradictions: { outcome: 'CLEAR', reasons: [] },
    clinicalSafety: { outcome: 'NEEDS_REVIEW', reasons: ['Fictional escalation needs a qualified clinical reviewer.'] }, feasibility: { outcome: 'CLEAR', reasons: [] },
  } }); accepted(r); const screened = (await f.db.getWorkflow(f.s.brief.requestId))!;
  accepted(await f.service.confirm(confirmation(screened), 'po')); const s = (await f.db.getWorkflow(f.s.brief.requestId))!;
  const route = routeDesignBrief({ currentRevision: s.brief, currentScreeningId: s.screening!.screeningId, brief: s.brief, screening: s.screening, confirmation: s.confirmation });
  assert.equal(route.route, 'NEEDS_SD_REVIEW'); assert.equal(route.clinicalApprovalRequired, true); assert.equal(s.routing, null);
});
test('material request revision invalidates all current downstream approval/build evidence', async () => {
  const f = requestFixture(), s = await at(f.db, 'WAITING_FOR_RELEASE_APPROVAL');
  accepted(await f.service.revise({ ...current(s, 'material-revision'), content: content(2) }, 'po'));
  const revised = (await f.db.getWorkflow(s.brief.requestId))!;
  for (const field of ['screening', 'confirmation', 'routing', 'logic', 'checks', 'clinicalApproval', 'artifact', 'verification', 'releaseApproval'] as const) assert.equal(revised[field], null);
  assert.equal(revised.status, 'WAITING_FOR_SCREENING'); assert.ok((await f.db.listEvidence(s.brief.requestId)).length > 3);
});
test('request creation rollback leaves no snapshot, state, receipt or partial audit', async () => {
  let fail = true; const f = requestFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('fictional failure'); } } });
  const r = await f.service.create(creation(), 'po'); assert.equal(r.status, 'STORAGE_FAILURE');
  assert.equal(await f.db.getWorkflow(r.requestId!), null); assert.deepEqual(await f.db.listSnapshots(r.requestId!), []); assert.deepEqual(await f.db.listAudit(r.requestId!), []);
  fail = false; accepted(await f.service.create(creation(), 'po'));
});
test('read storage failures return structured failure', async () => {
  const f = await created(), service = new RequestService({ store: wrapStore(f.db, { getWorkflow: async () => { throw Error('private detail'); } }), resolveActor: resolveRequestActor, validateSnapshot: provisionalSnapshotValidator });
  assert.equal((await service.get(f.s.brief.requestId, 'po')).status, 'STORAGE_FAILURE'); assert.equal((await service.create(creation(), 'po')).status, 'STORAGE_FAILURE');
});
for (const extra of [{ actorId: 'spoof' }, { trusted: true }, { roles: ['PO'] }, { requestId: 'client-chosen' }, { schemaVersion: 'other' }]) test(`creation rejects unexpected ${Object.keys(extra)[0]}`, async () => {
  const f = requestFixture(); assert.equal((await f.service.create({ ...creation(), ...extra }, 'po')).reason, 'INVALID_COMMAND');
});
test('creation rejects content-level authority fields', async () => {
  const f = requestFixture(); assert.equal((await f.service.create({ ...creation(), content: { ...content(), clinicalApproval: true } } as unknown as CreateRequestCommand, 'po')).reason, 'INVALID_COMMAND');
});
test('immutable snapshot history and audit copies cannot be mutated by callers', async () => {
  const f = await created(), snapshot = (await f.db.listSnapshots(f.s.brief.requestId))[0]; assert.throws(() => { (snapshot.content as { title: string }).title = 'changed'; });
  const audit = await f.db.listAudit(f.s.brief.requestId); (audit[0] as { reason: string }).reason = 'changed';
  assert.equal((await f.db.listAudit(f.s.brief.requestId))[0].reason, 'SUBMIT');
});

test('another PO cannot revise the owner request', async () => {
  const f = await created(); const r = await f.service.revise({ ...current(f.s, 'intruder-revision'), content: content(2) }, 'po2');
  assert.equal(r.reason, 'WRONG_OWNER'); assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('failed revision transaction cannot save partial snapshots or invalidate evidence', async () => {
  let fail = false; const f = requestFixture({ testFaults: { beforeCommit: () => { if (fail) throw Error('fictional failure'); } } });
  const created = await f.service.create(creation(), 'po'); const initial = (await f.db.getWorkflow(created.requestId!))!;
  accepted(await mockRole3(f.service).screen(current(initial, 'screen'))); const s = (await f.db.getWorkflow(created.requestId!))!;
  const before = await f.db.listAudit(s.brief.requestId); fail = true;
  const r = await f.service.revise({ ...current(s, 'revision-fail'), content: content(2) }, 'po'); assert.equal(r.status, 'STORAGE_FAILURE');
  fail = false; assert.deepEqual(await f.db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await f.db.listAudit(s.brief.requestId), before);
  assert.equal((await f.db.listSnapshots(s.brief.requestId)).length, 1); assert.equal(await f.db.getReceipt(s.brief.requestId, 'revision-fail'), null);
});
test('racing confirmation and material revision cannot both consume the same version', async () => {
  const f = await screened(); const results = await Promise.all([f.service.confirm(confirmation(f.s), 'po'),
    f.service.revise({ ...current(f.s, 'racing-revision'), content: content(2) }, 'po')]);
  assert.equal(results.filter(r => r.status === 'SUCCESS').length, 1); assert.equal(results.filter(r => r.status === 'STALE_VERSION').length, 1);
});
test('replayed accepted screening after revision cannot restore stale screening', async () => {
  const f = await created(), screen = current(f.s, 'screen'); accepted(await mockRole3(f.service).screen(screen));
  const s = (await f.db.getWorkflow(f.s.brief.requestId))!; accepted(await f.service.revise({ ...current(s, 'rev'), content: content(2) }, 'po'));
  const before = await f.db.getWorkflow(s.brief.requestId); assert.equal((await mockRole3(f.service).screen(screen)).status, 'DUPLICATE_EVENT');
  assert.deepEqual(await f.db.getWorkflow(s.brief.requestId), before);
});
test('creation retry after revisions does not create a second request or restore old content', async () => {
  const f = await created(); accepted(await f.service.revise({ ...current(f.s, 'rev'), content: content(2) }, 'po'));
  const before = await f.db.getWorkflow(f.s.brief.requestId); assert.equal((await f.service.create(creation(), 'po')).status, 'DUPLICATE_EVENT');
  assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), before);
});
test('malformed screening assessments cannot establish confirmation eligibility', async () => {
  const f = await created(), r = await mockRole3(f.service).screen(current(f.s, 'malformed-screen'), { checks: {} as never });
  assert.equal(r.reason, 'SCREENING_NOT_READY'); assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('stale screening identity cannot establish confirmation eligibility', async () => {
  const f = await created(), r = await mockRole3(f.service).screen(current(f.s, 'stale-screen'), { snapshotHash: 'e'.repeat(64) });
  assert.equal(r.reason, 'INVALID_SCREENING'); assert.deepEqual(await f.db.getWorkflow(f.s.brief.requestId), f.s);
});
test('accepted and rejected request attempts append audit without overwriting history', async () => {
  const f = await created(), before = await f.db.listAudit(f.s.brief.requestId);
  await f.service.confirm(confirmation(f.s), 'po'); const history = await f.db.listAudit(f.s.brief.requestId);
  assert.deepEqual(history.slice(0, before.length), before); assert.equal(history.at(-1)!.outcome, 'REJECTED'); assert.equal(history.at(-1)!.reason, 'WRONG_STATE');
});
test('snapshot schema rejection is invalid input rather than a false success', async () => {
  const f = requestFixture(), service = new RequestService({ store: f.db, resolveActor: resolveRequestActor, validateSnapshot: () => { throw Error('R4 schema rejected fictional content'); } });
  const r = await service.create(creation(), 'po'); assert.equal(r.reason, 'INVALID_COMMAND'); assert.equal(await f.db.getWorkflow(r.requestId!), null);
});
test('identity changes between service and atomic commit cannot transfer ownership', async () => {
  let calls = 0; const f = requestFixture({ resolveActor: principal => ++calls > 1 ? resolveRequestActor('po2') : resolveRequestActor(principal) });
  const service = new RequestService({ store: f.db, resolveActor: principal => { calls++; return resolveRequestActor(principal); }, validateSnapshot: provisionalSnapshotValidator });
  const r = await service.create(creation(), 'po'); assert.equal(r.reason, 'IDENTITY_CHANGED'); assert.equal(await f.db.getWorkflow(r.requestId!), null);
});

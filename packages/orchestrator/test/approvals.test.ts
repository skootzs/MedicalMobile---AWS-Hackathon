import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalService } from '../src/approvals.ts';
import type { ApprovalCommand } from '../src/approvals.ts';
import type { OrchestratorStore, ApplyCommand } from '../src/storage/requests.ts';
import type { WorkflowState } from '../src/workflow.ts';
import { logicModelIdentity, requestPreviewIdentity } from '../src/snapshots.ts';
import { at, store, resolveActor, command, model, preview, content, next } from './helpers/approval-fixtures.ts';

function service(db: OrchestratorStore, identity = resolveActor) {
  let attempt = 0;
  return new ApprovalService({ store: db, resolveActor: identity, newAttemptId: () => `approval-attempt-${++attempt}` });
}
function clinical(s: WorkflowState): ApprovalCommand {
  return { type: 'CLINICAL_DECISION', requestId: s.brief.requestId, eventId: `clinical-${s.version}`,
    expectedVersion: s.version, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    logicRevision: s.logic!.logicRevision, logicHash: s.logic!.logicHash, checkerReportId: s.checks?.reportId ?? 'not-checked', decision: 'APPROVE' };
}
function release(s: WorkflowState): ApprovalCommand {
  return { type: 'RELEASE_DECISION', requestId: s.brief.requestId, eventId: `release-${s.version}`,
    expectedVersion: s.version, requestRevision: s.brief.revision, requestSnapshotHash: s.brief.snapshotHash,
    logicRevision: s.logic!.logicRevision, logicHash: s.logic!.logicHash, decision: 'APPROVE',
    clinicalApprovalEventId: s.clinicalApproval?.eventId ?? 'missing-clinical', compilationId: s.artifact?.compilationId ?? 'missing-compile',
    artifactHash: s.artifact?.artifactHash ?? 'a'.repeat(64), verificationId: s.verification?.verificationId ?? 'missing-verification',
    verificationReportHash: s.verification?.reportHash ?? 'b'.repeat(64) };
}
function wrap(db: OrchestratorStore, changes: Partial<OrchestratorStore>): OrchestratorStore {
  return { apply: (c,p) => db.apply(c,p), getWorkflow: id => db.getWorkflow(id), getSnapshot: key => db.getSnapshot(key),
    listSnapshots: id => db.listSnapshots(id), getReceipt: (id,event) => db.getReceipt(id,event), listEvidence: id => db.listEvidence(id),
    listAudit: id => db.listAudit(id), ...changes };
}

test('authorized independent clinical approval commits state, receipt, evidence and audit', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), cmd = clinical(s);
  const r = await service(db).execute(cmd, 'clinic'); assert.equal(r.status, 'SUCCESS');
  const updated = (await db.getWorkflow(cmd.requestId))!;
  assert.equal(updated.status, 'CLINICALLY_APPROVED'); assert.equal(updated.clinicalApproval!.logicHash, cmd.logicHash);
  assert.equal(updated.clinicalApproval!.actorId, 'fictional-clinician');
  const receipt = (await db.getReceipt(cmd.requestId, cmd.eventId))!; assert.match(receipt.commandFingerprint!, /^[a-f0-9]{64}$/);
  assert.equal(receipt.auditId, r.auditId);
  assert.equal((await db.listEvidence(cmd.requestId)).filter(e => e.kind === 'CLINICAL_DECISION').length, 1);
});
for (const [principal, reason] of [['po', 'WRONG_ROLE'], ['poClinic', 'SELF_APPROVAL']] as const) {
  test(`clinical reviewer ${principal} cannot approve`, async () => {
    const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
    const r = await service(db).execute(clinical(s), principal); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, reason);
    assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
    const history = await db.listAudit(s.brief.requestId); assert.equal(history.at(-1)!.outcome, 'REJECTED'); assert.equal(history.at(-1)!.reason, reason);
  });
}
test('unknown principal cannot gain authority from browser-style identity/role fields', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db);
  const r = await app.execute(clinical(s), { id: 'fictional-clinician', roles: ['CLINICIAN'], trusted: true });
  assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'UNAUTHORIZED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('client-provided actor, roles, trusted flags and passing evidence flags are rejected as extra fields', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db);
  for (const extra of [{ actor: { id: 'clinic' } }, { roles: ['CLINICIAN'] }, { trusted: true }, { passed: true }, { expectedActorId: 'clinic' }]) {
    const r = await app.execute({ ...clinical(s), ...extra } as ApprovalCommand, 'po'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'INVALID_COMMAND');
  }
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
for (const field of ['logicHash', 'requestSnapshotHash'] as const) test(`stale ${field} cannot approve a different snapshot`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await service(db).execute({ ...clinical(s), [field]: 'e'.repeat(64) }, 'clinic'); assert.equal(r.status, 'STALE_VERSION');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('stale workflow version produces a structured conflict and audit', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await service(db).execute({ ...clinical(s), expectedVersion: s.version - 1 }, 'clinic');
  assert.equal(r.status, 'STALE_VERSION'); assert.equal(r.reason, 'VERSION_CONFLICT'); assert.ok(r.auditId);
});
test('an unchecked LogicModel cannot be approved', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_LOGIC_CHECKS');
  const r = await service(db).execute(clinical(s), 'clinic'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'CHECKER_EVIDENCE_REQUIRED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('failed checker evidence cannot be approved', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_LOGIC_CHECKS'), step = next(s);
  await db.apply({ ...step.cmd, event: { ...step.cmd.event, passed: false } } as ApplyCommand, step.who);
  const failed = (await db.getWorkflow(s.brief.requestId))!;
  const r = await service(db).execute(clinical(failed), 'clinic'); assert.equal(r.reason, 'CHECKER_EVIDENCE_REQUIRED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), failed);
});
test('wrong checker reference cannot be used even when current workflow checks passed', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await service(db).execute({ ...clinical(s), checkerReportId: 'different-report' } as ApprovalCommand, 'clinic');
  assert.equal(r.reason, 'CHECKER_EVIDENCE_MISMATCH'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
for (const fault of ['missing', 'failed', 'stale-model', 'wrong-request'] as const) test(`${fault} stored checker evidence blocks approval`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const facade = wrap(db, { listEvidence: async id => (await db.listEvidence(id)).flatMap(r => {
    if (r.event.type !== 'LOGIC_CHECKED') return [r];
    if (fault === 'missing') return [];
    return [{ ...r, event: { ...r.event, ...(fault === 'failed' ? { passed: false } : fault === 'stale-model' ? { logicHash: 'e'.repeat(64) } : { request: { ...r.event.request, revision: 99 } }) } }];
  }) });
  const r = await service(facade).execute(clinical(s), 'clinic'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'CHECKER_EVIDENCE_REQUIRED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('missing snapshot blocks clinical approval without manufacturing evidence', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const app = service(wrap(db, { getSnapshot: async key => key.kind === 'LOGIC_MODEL' ? null : db.getSnapshot(key) }));
  const r = await app.execute(clinical(s), 'clinic'); assert.equal(r.reason, 'SNAPSHOT_REQUIRED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('successful release approval uses authoritative verification evidence', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'), cmd = release(s);
  const r = await service(db).execute(cmd, 'release'); assert.equal(r.status, 'SUCCESS');
  const updated = (await db.getWorkflow(s.brief.requestId))!; assert.equal(updated.status, 'RELEASE_APPROVED');
  assert.equal(updated.releaseApproval!.artifactHash, s.artifact!.artifactHash); assert.equal(updated.releaseApproval!.reportHash, s.verification!.reportHash);
  assert.equal(updated.releaseApproval!.actorId, 'fictional-release');
});
test('missing clinical approval in current state blocks release', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
  const facade = wrap(db, { getWorkflow: async id => { const state = await db.getWorkflow(id); return state ? { ...state, clinicalApproval: null } : null; } });
  const r = await service(facade).execute(release(s), 'release'); assert.equal(r.reason, 'CLINICAL_APPROVAL_REQUIRED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
for (const kind of ['CLINICAL_DECISION', 'COMPILED', 'VERIFIED'] as const) test(`missing ${kind} history blocks release`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
  const app = service(wrap(db, { listEvidence: async id => (await db.listEvidence(id)).filter(r => r.kind !== kind) }));
  const r = await app.execute(release(s), 'release'); assert.equal(r.status, 'REJECTED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('failed verification cannot be overridden by a release command', async () => {
  const db = store(), s = await at(db, 'VERIFYING'), step = next(s); if (step.cmd.event.type !== 'VERIFIED') throw new Error('fixture');
  await db.apply({ ...step.cmd, event: { ...step.cmd.event, evidence: { ...step.cmd.event.evidence, passed: false } } }, step.who);
  const failed = (await db.getWorkflow(s.brief.requestId))!;
  const r = await service(db).execute(release(failed), 'release'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'VERIFICATION_REQUIRED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), failed);
});
for (const [field, value] of [['artifactHash', 'e'.repeat(64)], ['verificationReportHash', 'e'.repeat(64)], ['verificationId', 'old-run'], ['clinicalApprovalEventId', 'old-approval']] as const) {
  test(`outdated release ${field} cannot authorize current artifact`, async () => {
    const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
    const r = await service(db).execute({ ...release(s), [field]: value }, 'release'); assert.notEqual(r.status, 'SUCCESS'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
  });
}
for (const [who, reason] of [['po', 'WRONG_ROLE'], ['clinicRelease', 'REVIEWER_NOT_INDEPENDENT']] as const) test(`release by ${who} is blocked`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'); const r = await service(db).execute(release(s), who);
  assert.equal(r.reason, reason); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('concurrent approvals only advance the workflow once', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db), cmd = clinical(s);
  const results = await Promise.all([app.execute(cmd, 'clinic'), app.execute({ ...cmd, eventId: 'competing-approval' }, 'clinic')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['STALE_VERSION', 'SUCCESS']);
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version + 1);
  assert.equal((await db.listEvidence(s.brief.requestId)).filter(e => e.kind === 'CLINICAL_DECISION').length, 1);
});
for (const phase of ['clinical', 'release'] as const) test(`duplicate ${phase} event does not create another approval`, async () => {
  const db = store(), s = await at(db, phase === 'clinical' ? 'WAITING_FOR_CLINICAL_APPROVAL' : 'WAITING_FOR_RELEASE_APPROVAL'), app = service(db);
  const cmd = phase === 'clinical' ? clinical(s) : release(s);
  assert.equal((await app.execute(cmd, phase === 'clinical' ? 'clinic' : 'release')).status, 'SUCCESS');
  assert.equal((await app.execute(cmd, phase === 'clinical' ? 'clinic' : 'release')).status, 'DUPLICATE_EVENT');
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version + 1);
  const history = await db.listAudit(s.brief.requestId); assert.deepEqual(history.slice(-2).map(a => a.outcome), ['ACCEPTED', 'DUPLICATE']);
});
test('same event ID with different application-only checker reference is not a duplicate', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db), cmd = clinical(s);
  await app.execute(cmd, 'clinic');
  const r = await app.execute({ ...cmd, checkerReportId: 'changed-reference' } as ApprovalCommand, 'clinic');
  assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'EVENT_ID_REUSED');
  assert.equal((await db.listEvidence(s.brief.requestId)).filter(e => e.kind === 'CLINICAL_DECISION').length, 1);
});
test('LogicModel change invalidates approval and rejects a stale model reference', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db), cmd = clinical(s);
  await app.execute(cmd, 'clinic'); let current = (await db.getWorkflow(s.brief.requestId))!;
  const snapshot = model(current, 2); await db.apply(command(current, { type: 'REVISE_LOGIC', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] }), 'ai');
  current = (await db.getWorkflow(s.brief.requestId))!; assert.equal(current.clinicalApproval, null);
  const r = await app.execute({ ...cmd, eventId: 'old-model-new-event', expectedVersion: current.version }, 'clinic'); assert.equal(r.status, 'STALE_VERSION'); assert.equal(r.reason, 'STALE_LOGIC');
});
test('an exact old approval retry stays duplicate after a request revision', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db), cmd = clinical(s); await app.execute(cmd, 'clinic');
  const current = (await db.getWorkflow(s.brief.requestId))!, snapshot = preview(2);
  await db.apply(command(current, { type: 'REVISE_REQUEST', brief: { ...content(2), ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot] }), 'po');
  const before = await db.getWorkflow(s.brief.requestId), r = await app.execute(cmd, 'clinic'); assert.equal(r.status, 'DUPLICATE_EVENT'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), before);
});
test('commit failure returns structured failure with no partial approval or audit', async () => {
  let fail = false; const db = store({ testFaults: { beforeCommit: () => { if (fail) throw new Error('Fictional storage failure'); } } });
  const s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), beforeAudit = await db.listAudit(s.brief.requestId), beforeEvidence = await db.listEvidence(s.brief.requestId), cmd = clinical(s);
  fail = true; const r = await service(db).execute(cmd, 'clinic'); fail = false;
  assert.equal(r.status, 'STORAGE_FAILURE'); assert.equal(r.reason, 'TRANSACTION_FAILED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await db.listAudit(s.brief.requestId), beforeAudit); assert.deepEqual(await db.listEvidence(s.brief.requestId), beforeEvidence);
  assert.equal(await db.getReceipt(s.brief.requestId, cmd.eventId), null);
});
test('storage read errors cannot become approval success', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await service(wrap(db, { getWorkflow: async () => { throw new Error('Fictional read failure'); } })).execute(clinical(s), 'clinic');
  assert.equal(r.status, 'STORAGE_FAILURE'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('unauthenticated commands do not read snapshots or workflow state', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'); let reads = 0;
  const r = await service(wrap(db, { getWorkflow: async () => { reads++; return s; }, getReceipt: async () => { reads++; return null; } })).execute(clinical(s), 'unknown');
  assert.equal(r.reason, 'UNAUTHORIZED'); assert.equal(reads, 0);
});
test('identity change between preflight and commit is rejected', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const app = new ApprovalService({ store: db, resolveActor: () => ({ id: 'different-clinician', roles: ['CLINICIAN'] }) });
  const r = await app.execute(clinical(s), 'clinic'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'IDENTITY_CHANGED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
for (const decision of ['REJECT', 'RETURN'] as const) test(`service supports explicit clinical ${decision} without approval`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const r = await service(db).execute({ ...clinical(s), decision, note: 'Fictional interpretation needs correction.' }, 'clinic'); assert.equal(r.status, 'SUCCESS');
  const updated = (await db.getWorkflow(s.brief.requestId))!; assert.equal(updated.status, decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION'); assert.equal(updated.clinicalApproval, null);
});
test('malformed commands and missing backend identity boundary fail closed', async () => {
  const db = store(), app = service(db);
  for (const invalid of [null, {}, { type: 'CLINICAL_DECISION', roles: ['CLINICIAN'] }]) assert.equal((await app.execute(invalid as unknown as ApprovalCommand, 'clinic')).reason, 'INVALID_COMMAND');
  assert.throws(() => new ApprovalService({ store: db } as never));
});

test('same identity losing its reviewer role before commit cannot approve', async () => {
  let revoked = false;
  const identities = (p: unknown) => p === 'clinic' && revoked ? { id: 'fictional-clinician', roles: ['PO'] as const } : resolveActor(p);
  const db = store({ resolveActor: identities }), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const facade = wrap(db, { apply: (cmd, p) => { revoked = true; return db.apply(cmd, p); } });
  const app = new ApprovalService({ store: facade, resolveActor: identities });
  const r = await app.execute(clinical(s), 'clinic'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'WRONG_ROLE');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('identity-provider failure cannot fall back to an approval', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const app = new ApprovalService({ store: db, resolveActor: () => { throw new Error('Fictional identity outage'); } });
  const r = await app.execute(clinical(s), 'clinic'); assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'UNAUTHORIZED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('concurrent identical approvals produce success plus duplicate without a second approval record', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db), cmd = clinical(s);
  const results = await Promise.all([app.execute(cmd, 'clinic'), app.execute(cmd, 'clinic')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['DUPLICATE_EVENT', 'SUCCESS']);
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version + 1);
  assert.equal((await db.listEvidence(s.brief.requestId)).filter(r => r.kind === 'CLINICAL_DECISION').length, 1);
});
test('reusing a release event ID with different approval reference is rejected', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'), app = service(db), cmd = release(s);
  await app.execute(cmd, 'release');
  const r = await app.execute({ ...cmd, clinicalApprovalEventId: 'different-clinical-record' } as ApprovalCommand, 'release');
  assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'EVENT_ID_REUSED');
});
test('another clinician cannot claim an already recorded approval event', async () => {
  const identities = (p: unknown) => p === 'other-clinic' ? { id: 'different-clinician', roles: ['CLINICIAN'] as const } : resolveActor(p);
  const db = store({ resolveActor: identities }), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const app = new ApprovalService({ store: db, resolveActor: identities }), cmd = clinical(s);
  await app.execute(cmd, 'clinic'); const r = await app.execute(cmd, 'other-clinic');
  assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'EVENT_ID_REUSED');
});
for (const decision of ['REJECT', 'RETURN'] as const) test(`release ${decision} records the decision without unlocking download`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
  const r = await service(db).execute({ ...release(s), decision, note: 'Fictional release evidence needs correction.' }, 'release');
  assert.equal(r.status, 'SUCCESS'); const updated = (await db.getWorkflow(s.brief.requestId))!;
  assert.equal(updated.status, decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION'); assert.equal(updated.releaseApproval, null);
});
test('release contributor cannot gain permission by holding the release role too', async () => {
  const identities = (p: unknown) => p === 'po-release' ? { id: 'fictional-po', roles: ['RELEASE_APPROVER'] as const } : resolveActor(p);
  const db = store({ resolveActor: identities }), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL');
  const app = new ApprovalService({ store: db, resolveActor: identities });
  const r = await app.execute(release(s), 'po-release'); assert.equal(r.reason, 'REVIEWER_NOT_INDEPENDENT');
});
test('same backend attempt replay has no additional audit or approval record', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const app = new ApprovalService({ store: db, resolveActor, newAttemptId: () => 'fixed-server-attempt' }), cmd = clinical(s);
  const first = await app.execute(cmd, 'clinic'), history = await db.listAudit(s.brief.requestId), second = await app.execute(cmd, 'clinic');
  assert.equal(first.status, 'SUCCESS'); assert.equal(second.status, 'DUPLICATE_EVENT'); assert.equal(second.replayed, true);
  assert.deepEqual(await db.listAudit(s.brief.requestId), history);
});
test('unsupported metadata and invalid decisions cannot become approval commands', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), app = service(db);
  for (const changes of [{ expectedVersion: -1 }, { expectedVersion: 1.5 }, { logicHash: 'fake' }, { requestRevision: 0 },
    { decision: 'CONFIRMED' }, { decision: 'RETURN' }, { note: '' }]) {
    const r = await app.execute({ ...clinical(s), ...changes } as ApprovalCommand, 'clinic'); assert.equal(r.reason, 'INVALID_COMMAND');
  }
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});

test('malformed truthy checker pass values cannot substitute for boolean success', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const facade = wrap(db, { listEvidence: async id => (await db.listEvidence(id)).map(record => record.event.type === 'LOGIC_CHECKED'
    ? { ...record, event: { ...record.event, passed: 'true' } } as unknown as typeof record : record) });
  const r = await service(facade).execute(clinical(s), 'clinic'); assert.equal(r.reason, 'CHECKER_EVIDENCE_REQUIRED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});
test('ambiguous duplicate checker records block approval', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL');
  const facade = wrap(db, { listEvidence: async id => { const records = await db.listEvidence(id); return [...records, ...records.filter(record => record.kind === 'LOGIC_CHECKED')]; } });
  const r = await service(facade).execute(clinical(s), 'clinic'); assert.equal(r.reason, 'CHECKER_EVIDENCE_REQUIRED');
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s);
});

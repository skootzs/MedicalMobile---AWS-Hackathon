import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnapshot, provisionalSnapshotValidator, requestPreviewIdentity, logicModelIdentity } from '../src/snapshots.ts';
import type { Snapshot } from '../src/snapshots.ts';
import { routeDesignBrief } from '../src/routing.ts';
import type { Actor, WorkflowState, WorkflowStatus } from '../src/workflow.ts';
import { InMemoryOrchestratorStore } from '../src/storage/memory.ts';
import type { InMemoryOptions } from '../src/storage/memory.ts';
import { StorageError } from '../src/storage/requests.ts';
import type { ApplyCommand, WorkflowCommand } from '../src/storage/requests.ts';
import { snapshotKey, verifySnapshot } from '../src/storage/snapshots.ts';

const HASH = (digit: string) => digit.repeat(64); // Fictional artifact/report fingerprints only.
const people: Record<string, Actor> = {
  po: { id: 'fictional-po', roles: ['PO'] }, ai: { id: 'fictional-ai', roles: ['DRAFTER'] },
  checker: { id: 'fictional-checker', roles: ['CHECKER'] }, clinic: { id: 'fictional-clinician', roles: ['CLINICIAN'] },
  compiler: { id: 'fictional-compiler', roles: ['COMPILER'] }, verifier: { id: 'fictional-verifier', roles: ['VERIFIER'] },
  release: { id: 'fictional-release', roles: ['RELEASE_APPROVER'] }, backend: { id: 'fictional-backend', roles: ['ORCHESTRATOR'] },
  poClinic: { id: 'fictional-po', roles: ['CLINICIAN'] }, clinicRelease: { id: 'fictional-clinician', roles: ['RELEASE_APPROVER'] },
};
const resolveActor = (principal: unknown) => typeof principal === 'string' ? people[principal] ?? null : null;
function store(options: Partial<InMemoryOptions> = {}) {
  return new InMemoryOrchestratorStore({ resolveActor, validateSnapshot: provisionalSnapshotValidator,
    now: () => '2026-11-03T12:00:00.000Z', ...options });
}
function content(revision = 1) {
  return { title: `Fictional training checklist ${revision}`, objective: 'Record a training visit.', targetPopulation: 'Fictional training households',
    requirements: [{ condition: 'Checklist completed', action: 'Show completion message' }] };
}
function preview(revision = 1, requestId = 'fictional-001') {
  return createSnapshot({ kind: 'REQUEST_PREVIEW', requestId, revision, schemaVersion: '1.0', content: content(revision) }, provisionalSnapshotValidator);
}
function model(s: WorkflowState, revision = 1) {
  return createSnapshot({ kind: 'LOGIC_MODEL', requestId: s.brief.requestId, revision, schemaVersion: '1.0',
    requestPreview: { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash },
    content: { schemaVersion: '1.0', pathwayId: 'fictional-training', title: `Fictional model ${revision}`, language: 'en',
      sources: [{ id: 'fictional-guide', title: 'Fictional training guide' }], context: [],
      questions: [{ id: 'complete', type: 'boolean', label: 'Fictional training complete?' }], derived: [],
      decisionTables: [{ id: 'classification', hitPolicy: 'first', rows: [], otherwise: 'complete' }],
      outcomes: [{ id: 'complete', label: 'Training complete', referral: 'none' }], ambiguities: [] },
  }, provisionalSnapshotValidator);
}
function command(s: WorkflowState | null, payload: Record<string, unknown>, options: { snapshots?: readonly Snapshot[]; suffix?: string; requestId?: string } = {}): ApplyCommand {
  const ref = s ? { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash } : requestPreviewIdentity(preview(1, options.requestId));
  const event = { eventId: `event-${s?.version ?? 0}-${payload.type}${options.suffix ?? ''}`, expectedVersion: s?.version ?? 0, request: ref, ...payload } as WorkflowCommand;
  return { requestId: ref.requestId, attemptId: `attempt-${event.eventId}${options.suffix ?? ''}`, event, ...(options.snapshots ? { snapshots: options.snapshots } : {}) };
}
function submit(revision = 1, requestId = 'fictional-001'): ApplyCommand {
  const snapshot = preview(revision, requestId);
  return command(null, { type: 'SUBMIT', brief: { ...content(revision), ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot], requestId });
}
async function accepted(db: InMemoryOrchestratorStore, cmd: ApplyCommand, who = 'backend') {
  const result = await db.apply(cmd, who);
  assert.equal(result.outcome, 'ACCEPTED', result.reason);
  return (await db.getWorkflow(cmd.requestId))!;
}
function next(s: WorkflowState): { cmd: ApplyCommand; who: string } {
  const ref = { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash };
  switch (s.status) {
    case 'WAITING_FOR_SCREENING': return { who: 'ai', cmd: command(s, { type: 'SCREENING_COMPLETED', screening: {
      ...ref, screeningId: `screen-${s.brief.revision}`, status: 'COMPLETED', checks: {
        completeness: { outcome: 'CLEAR', reasons: [] }, ambiguities: { outcome: 'CLEAR', reasons: [] },
        contradictions: { outcome: 'CLEAR', reasons: [] }, clinicalSafety: { outcome: 'CLEAR', reasons: [] }, feasibility: { outcome: 'CLEAR', reasons: [] },
      } } }) };
    case 'WAITING_FOR_PO_CONFIRMATION': return { who: 'po', cmd: command(s, { type: 'PO_DECISION', confirmation: { ...ref, confirmationId: `confirm-${s.brief.revision}`, screeningId: s.screening!.screeningId, decision: 'CONFIRMED' } }) };
    case 'READY_TO_ROUTE': return { who: 'backend', cmd: command(s, { type: 'APPLY_ROUTING', result: routeDesignBrief({ currentRevision: ref, currentScreeningId: s.screening!.screeningId, brief: s.brief, screening: s.screening, confirmation: s.confirmation }) }) };
    case 'READY_FOR_LOGIC_PROPOSAL': return { who: 'backend', cmd: command(s, { type: 'START_LOGIC_PROPOSAL' }) };
    case 'DRAFTING_LOGIC': {
      const snapshot = model(s); return { who: 'ai', cmd: command(s, { type: 'LOGIC_PROPOSED', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] }) };
    }
    case 'WAITING_FOR_LOGIC_CHECKS': return { who: 'checker', cmd: command(s, { type: 'LOGIC_CHECKED', ...s.logic, reportId: `checks-${s.version}`, passed: true }) };
    case 'WAITING_FOR_CLINICAL_APPROVAL': return { who: 'clinic', cmd: command(s, { type: 'CLINICAL_DECISION', ...s.logic, decision: 'APPROVE' }) };
    case 'CLINICALLY_APPROVED': return { who: 'backend', cmd: command(s, { type: 'START_COMPILATION', compilationId: `compile-${s.version}` }) };
    case 'COMPILING': return { who: 'compiler', cmd: command(s, { type: 'COMPILED', artifact: { ...s.logic, compilationId: s.compilationId, artifactHash: HASH('c') } }) };
    case 'WAITING_FOR_VERIFICATION': return { who: 'backend', cmd: command(s, { type: 'START_VERIFICATION', verificationId: `verify-${s.version}` }) };
    case 'VERIFYING': return { who: 'verifier', cmd: command(s, { type: 'VERIFIED', evidence: { ...s.artifact, verificationId: s.verificationId, reportHash: HASH('d'), passed: true } }) };
    case 'WAITING_FOR_RELEASE_APPROVAL': return { who: 'release', cmd: command(s, { type: 'RELEASE_DECISION', evidence: s.verification, decision: 'APPROVE' }) };
    case 'RELEASE_APPROVED': return { who: 'backend', cmd: command(s, { type: 'MAKE_DOWNLOAD_AVAILABLE' }) };
    default: throw new Error(`No next event for ${s.status}`);
  }
}
async function at(db: InMemoryOrchestratorStore, target: WorkflowStatus): Promise<WorkflowState> {
  let s = await accepted(db, submit(), 'po');
  while (s.status !== target) { const { cmd, who } = next(s); s = await accepted(db, cmd, who); }
  return s;
}
async function unchanged(db: InMemoryOrchestratorStore, before: WorkflowState, cmd: ApplyCommand, who: string, reason?: string) {
  const receipt = await db.getReceipt(cmd.requestId, cmd.event.eventId);
  const result = await db.apply(cmd, who); assert.equal(result.outcome, 'REJECTED');
  if (reason) assert.equal(result.reason, reason);
  assert.deepEqual(await db.getWorkflow(before.brief.requestId), before);
  assert.deepEqual(await db.getReceipt(cmd.requestId, cmd.event.eventId), receipt);
  return result;
}
const code = (expected: string) => (e: unknown) => e instanceof StorageError && e.code === expected;

test('create request atomically saves preview, workflow, receipt and audit', async () => {
  const db = store(), cmd = submit(); const result = await db.apply(cmd, 'po');
  assert.equal(result.outcome, 'ACCEPTED'); assert.equal(result.version, 1);
  const s = (await db.getWorkflow(cmd.requestId))!; assert.equal(s.status, 'WAITING_FOR_SCREENING');
  assert.equal((await db.listSnapshots(cmd.requestId)).length, 1);
  const receipt = (await db.getReceipt(cmd.requestId, cmd.event.eventId))!;
  assert.equal(receipt.auditId, result.auditId); assert.equal(receipt.workflowVersion, 1);
  const audit = await db.listAudit(cmd.requestId); assert.equal(audit.length, 1); assert.equal(audit[0].outcome, 'ACCEPTED');
  assert.equal(audit[0].recordedAt, '2026-11-03T12:00:00.000Z');
});
test('missing records return null or empty histories', async () => {
  const db = store(); assert.equal(await db.getWorkflow('missing'), null);
  assert.equal(await db.getSnapshot({ requestId: 'missing', kind: 'REQUEST_PREVIEW', revision: 1 }), null);
  assert.equal(await db.getReceipt('missing', 'missing'), null);
  assert.deepEqual(await db.listAudit('missing'), []); assert.deepEqual(await db.listEvidence('missing'), []);
});
test('same attempt replay returns original result without extra audit or transition', async () => {
  const db = store(), cmd = submit(); const first = await db.apply(cmd, 'po'), second = await db.apply(cmd, 'po');
  assert.deepEqual(second, { ...first, replayed: true }); assert.equal((await db.listAudit(cmd.requestId)).length, 1);
  assert.equal((await db.getWorkflow(cmd.requestId))!.version, 1);
});
test('same event with a new attempt appends a duplicate audit but no receipt/state twice', async () => {
  const db = store(), cmd = submit(); await db.apply(cmd, 'po');
  const duplicate = await db.apply({ ...cmd, attemptId: 'retry' }, 'po');
  assert.equal(duplicate.outcome, 'DUPLICATE'); assert.equal((await db.getWorkflow(cmd.requestId))!.version, 1);
  const audits = await db.listAudit(cmd.requestId); assert.deepEqual(audits.map(a => a.outcome), ['ACCEPTED', 'DUPLICATE']);
  assert.equal((await db.getReceipt(cmd.requestId, cmd.event.eventId))!.auditId, audits[0].auditId);
});
test('event ID reuse with changed payload is rejected and audited', async () => {
  const db = store(); const cmd = submit(); const s = await accepted(db, cmd, 'po');
  const changed = { ...cmd, attemptId: 'changed-event', event: { ...cmd.event, expectedVersion: 99 } };
  await unchanged(db, s, changed, 'po', 'EVENT_ID_REUSED'); assert.equal((await db.listAudit(cmd.requestId)).length, 2);
});
test('attempt ID reuse cannot overwrite an audit entry', async () => {
  const db = store(), cmd = submit(); await db.apply(cmd, 'po');
  await assert.rejects(db.apply({ ...cmd, event: { ...cmd.event, expectedVersion: 99 } }, 'po'), code('ATTEMPT_ID_REUSED'));
  assert.equal((await db.listAudit(cmd.requestId)).length, 1);
});
test('stale expected workflow version is rejected without state changes', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s);
  await unchanged(db, s, { ...step.cmd, event: { ...step.cmd.event, expectedVersion: 0 } }, step.who, 'VERSION_CONFLICT');
});
test('concurrent different events cannot both advance the same workflow version', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s);
  const other = { ...step.cmd, attemptId: 'competing', event: { ...step.cmd.event, eventId: 'competing-screen' } };
  const results = await Promise.all([db.apply(step.cmd, step.who), db.apply(other, step.who)]);
  assert.deepEqual(results.map(r => r.outcome).sort(), ['ACCEPTED', 'REJECTED']);
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version + 1);
  assert.equal((await db.listEvidence(s.brief.requestId)).length, 1);
});
test('concurrent identical event retries advance only once', async () => {
  const db = store(), cmd = submit(); const results = await Promise.all([db.apply(cmd, 'po'), db.apply(cmd, 'po')]);
  assert.deepEqual(results.map(r => r.replayed), [false, true]);
  assert.equal((await db.listAudit(cmd.requestId)).length, 1); assert.equal((await db.getWorkflow(cmd.requestId))!.version, 1);
});
test('actor resolution can complete out of order without stale state overwrite', async () => {
  let slowRelease: (() => void) | undefined;
  const db = store({ resolveActor: async p => { if (p === 'slow') { await new Promise<void>(r => { slowRelease = r; }); return people.ai; } return resolveActor(p); } });
  const s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s);
  const slow = db.apply({ ...step.cmd, attemptId: 'slow', event: { ...step.cmd.event, eventId: 'slow' } }, 'slow');
  const fast = await db.apply(step.cmd, 'ai'); assert.equal(fast.outcome, 'ACCEPTED'); slowRelease!();
  const last = await slow; assert.equal(last.outcome, 'REJECTED'); assert.equal(last.reason, 'VERSION_CONFLICT');
});
test('snapshot bytes are reverified on direct, list and workflow loads', async () => {
  let corrupt = false;
  const db = store({ testFaults: { readSnapshotBytes: bytes => corrupt ? bytes.replace('Fictional training checklist', 'Altered training checklist') : bytes } });
  const cmd = submit(); await db.apply(cmd, 'po'); corrupt = true;
  await assert.rejects(db.getSnapshot(snapshotKey(preview())), code('SNAPSHOT_INTEGRITY'));
  await assert.rejects(db.listSnapshots(cmd.requestId), code('SNAPSHOT_INTEGRITY'));
  await assert.rejects(db.getWorkflow(cmd.requestId), code('SNAPSHOT_INTEGRITY'));
  corrupt = false; assert.equal((await db.getWorkflow(cmd.requestId))!.version, 1);
});
test('wrong hash, unknown hash policy and unknown stored metadata fail verification', () => {
  const p = preview();
  for (const changes of [{ snapshotHash: HASH('b') }, { hashPolicyVersion: 'unknown' }, { extra: true }]) assert.throws(() => verifySnapshot({ ...p, ...changes }, provisionalSnapshotValidator), code('SNAPSHOT_INTEGRITY'));
});
test('tampered snapshot submission saves only a rejection audit', async () => {
  const db = store(), cmd = submit(), p = preview();
  const result = await db.apply({ ...cmd, snapshots: [{ ...p, snapshotHash: HASH('b') }] }, 'po');
  assert.equal(result.reason, 'SNAPSHOT_INTEGRITY'); assert.equal(await db.getWorkflow(cmd.requestId), null);
  assert.deepEqual(await db.listSnapshots(cmd.requestId), []); assert.equal(await db.getReceipt(cmd.requestId, cmd.event.eventId), null);
  assert.equal((await db.listAudit(cmd.requestId))[0].outcome, 'REJECTED');
});
test('missing snapshot and mismatched request content cannot establish state', async () => {
  const db = store(), cmd = submit();
  assert.equal((await db.apply({ ...cmd, snapshots: [] }, 'po')).reason, 'SNAPSHOT_REQUIRED');
  if (cmd.event.type !== 'SUBMIT') throw new Error('fixture');
  const changed = { ...cmd, attemptId: 'mismatched', event: { ...cmd.event, brief: { ...cmd.event.brief, objective: 'Different unhashed content' } } };
  assert.equal((await db.apply(changed, 'po')).reason, 'REQUEST_CONTENT_MISMATCH');
  assert.equal(await db.getWorkflow(cmd.requestId), null); assert.deepEqual(await db.listSnapshots(cmd.requestId), []);
});
test('request revisions preserve immutable old snapshots and invalidate approvals', async () => {
  const db = store(), s = await at(db, 'RELEASE_APPROVED'), p = preview(2);
  const cmd = command(s, { type: 'REVISE_REQUEST', brief: { ...content(2), ...requestPreviewIdentity(p) } }, { snapshots: [p] });
  const revised = await accepted(db, cmd, 'po'); assert.equal(revised.status, 'WAITING_FOR_SCREENING'); assert.equal(revised.clinicalApproval, null); assert.equal(revised.releaseApproval, null);
  const history = await db.listSnapshots(cmd.requestId); assert.equal(history.length, 3);
  assert.equal((await db.getSnapshot(snapshotKey(preview())))!.snapshotHash, preview().snapshotHash);
  assert.equal((await db.listEvidence(cmd.requestId)).filter(e => e.kind === 'CLINICAL_DECISION').length, 1);
});
test('same snapshot slot cannot silently replace earlier content', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s);
  const replacement = createSnapshot({ kind: 'REQUEST_PREVIEW', requestId: s.brief.requestId, revision: 1, schemaVersion: '1.0', content: content(9) }, provisionalSnapshotValidator);
  await unchanged(db, s, { ...step.cmd, snapshots: [replacement] }, step.who, 'SNAPSHOT_CONFLICT');
  assert.equal((await db.getSnapshot(snapshotKey(preview())))!.snapshotHash, preview().snapshotHash);
});
test('LogicModel snapshot is mandatory and must match its current preview and event hash', async () => {
  const db = store(), s = await at(db, 'DRAFTING_LOGIC'), step = next(s);
  await unchanged(db, s, { ...step.cmd, snapshots: [] }, 'ai', 'SNAPSHOT_REQUIRED');
  const bad = { ...step.cmd, attemptId: 'bad-model-hash', event: { ...step.cmd.event, logicHash: HASH('e') } as WorkflowCommand };
  await unchanged(db, s, bad, 'ai', 'SNAPSHOT_REQUIRED'); assert.equal((await db.listSnapshots(s.brief.requestId)).length, 1);
});
test('LogicModel revision 1 after a new preview has a distinct immutable storage slot', async () => {
  const db = store(), s = await at(db, 'CLINICALLY_APPROVED'), p = preview(2);
  let revised = await accepted(db, command(s, { type: 'REVISE_REQUEST', brief: { ...content(2), ...requestPreviewIdentity(p) } }, { snapshots: [p] }), 'po');
  while (revised.status !== 'WAITING_FOR_LOGIC_CHECKS') { const step = next(revised); revised = await accepted(db, step.cmd, step.who); }
  const models = (await db.listSnapshots(s.brief.requestId)).filter(p => p.kind === 'LOGIC_MODEL');
  assert.equal(models.length, 2); assert.equal(models[0].revision, 1); assert.equal(models[1].revision, 1); assert.notEqual(models[0].snapshotHash, models[1].snapshotHash);
});
test('returned records are copies and snapshots remain frozen', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_PO_CONFIRMATION');
  const loaded = (await db.getWorkflow(s.brief.requestId))!; loaded.brief.title = 'Changed copy'; loaded.version = 99;
  const audit = [...await db.listAudit(s.brief.requestId)]; audit[0].reason = 'Changed audit copy';
  const evidence = [...await db.listEvidence(s.brief.requestId)]; evidence[0].event.actor.id = 'Changed actor copy';
  const receipt = (await db.getReceipt(s.brief.requestId, submit().event.eventId))!; receipt.workflowVersion = 99;
  const p = (await db.getSnapshot(snapshotKey(preview())))!; assert.throws(() => { (p.content as Record<string, unknown>).title = 'Changed'; });
  assert.equal((await db.getWorkflow(s.brief.requestId))!.version, s.version);
  assert.notEqual((await db.listAudit(s.brief.requestId))[0].reason, 'Changed audit copy');
  assert.notEqual((await db.listEvidence(s.brief.requestId))[0].event.actor.id, 'Changed actor copy');
  assert.equal((await db.getReceipt(s.brief.requestId, submit().event.eventId))!.workflowVersion, 1);
});
test('audit history appends accepted, rejected and duplicate attempts in sequence', async () => {
  const db = store(), cmd = submit(), s = await accepted(db, cmd, 'po');
  await db.apply({ ...cmd, attemptId: 'retry' }, 'po'); const step = next(s); await db.apply(step.cmd, 'po');
  const audits = await db.listAudit(cmd.requestId);
  assert.deepEqual(audits.map(a => a.outcome), ['ACCEPTED', 'DUPLICATE', 'REJECTED']);
  assert.deepEqual(audits.map(a => a.sequence), [1, 2, 3]); assert.equal(new Set(audits.map(a => a.auditId)).size, 3);
});
test('before-commit failure rolls back workflow, snapshots, receipts and audit', async () => {
  let fail = true; const db = store({ testFaults: { beforeCommit: () => { if (fail) throw new Error('Fictional disk failure'); } } }), cmd = submit();
  await assert.rejects(db.apply(cmd, 'po'), code('TRANSACTION_FAILED'));
  assert.equal(await db.getWorkflow(cmd.requestId), null); assert.deepEqual(await db.listSnapshots(cmd.requestId), []);
  assert.deepEqual(await db.listAudit(cmd.requestId), []); assert.equal(await db.getReceipt(cmd.requestId, cmd.event.eventId), null);
  fail = false; assert.equal((await db.apply(cmd, 'po')).outcome, 'ACCEPTED');
});
test('failed transaction cannot partly save evidence or an approval', async () => {
  let fail = false; const db = store({ testFaults: { beforeCommit: () => { if (fail) throw new Error('Fictional failure'); } } });
  const s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), step = next(s), audits = await db.listAudit(s.brief.requestId), evidence = await db.listEvidence(s.brief.requestId);
  fail = true; await assert.rejects(db.apply(step.cmd, step.who), code('TRANSACTION_FAILED')); fail = false;
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await db.listAudit(s.brief.requestId), audits);
  assert.deepEqual(await db.listEvidence(s.brief.requestId), evidence); assert.equal(await db.getReceipt(s.brief.requestId, step.cmd.event.eventId), null);
  assert.equal((await db.apply(step.cmd, step.who)).outcome, 'ACCEPTED');
});
test('clock failures do not partly save transactions', async () => {
  const db = store({ now: () => { throw new Error('Fictional clock unavailable'); } }), cmd = submit();
  await assert.rejects(db.apply(cmd, 'po')); assert.equal(await db.getWorkflow(cmd.requestId), null);
  assert.deepEqual(await db.listAudit(cmd.requestId), []); assert.deepEqual(await db.listSnapshots(cmd.requestId), []);
});
test('unresolved principals are rejected and audited without trusting roles in the principal', async () => {
  const db = store(), cmd = submit(); const result = await db.apply(cmd, { id: 'admin', roles: ['PO', 'CLINICIAN'], trusted: true });
  assert.equal(result.outcome, 'REJECTED'); assert.equal(result.reason, 'UNAUTHORIZED'); assert.equal(result.version, null);
  assert.equal(await db.getWorkflow(cmd.requestId), null); assert.equal((await db.listAudit(cmd.requestId))[0].actorId, null);
});
test('actors embedded in commands and arbitrary next-state/approval claims are rejected', async () => {
  const db = store(), cmd = submit();
  const result = await db.apply({ ...cmd, event: { ...cmd.event, actor: people.po } } as unknown as ApplyCommand, 'backend'); assert.equal(result.reason, 'INVALID_COMMAND');
  const other = await db.apply({ ...cmd, attemptId: 'direct-state', nextState: { status: 'DOWNLOAD_READY' }, approval: true } as ApplyCommand, 'po');
  assert.equal(other.reason, 'INVALID_COMMAND'); assert.equal(await db.getWorkflow(cmd.requestId), null);
});
test('invalid command events are audited without changing authorized state', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING');
  const bad = command(s, { type: 'BYPASS_APPROVALS' }); await unchanged(db, s, bad, 'backend', 'UNKNOWN_EVENT');
  await assert.rejects(db.apply({ ...bad, attemptId: '' }, 'backend'), code('INVALID_COMMAND'));
});
test('request scoping and cross-request snapshots cannot contaminate another workflow', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s);
  await unchanged(db, s, { ...step.cmd, snapshots: [preview(1, 'fictional-002')] }, step.who, 'SNAPSHOT_SCOPE_MISMATCH');
  const result = await db.apply({ ...step.cmd, attemptId: 'scope', requestId: 'fictional-002' }, step.who); assert.equal(result.reason, 'REQUEST_SCOPE_MISMATCH');
  assert.equal(await db.getWorkflow('fictional-002'), null);
});
test('evidence record IDs cannot overwrite an earlier screening after revision', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_PO_CONFIRMATION'), p = preview(2);
  const revised = await accepted(db, command(s, { type: 'REVISE_REQUEST', brief: { ...content(2), ...requestPreviewIdentity(p) } }, { snapshots: [p] }), 'po');
  const step = next(revised); if (step.cmd.event.type !== 'SCREENING_COMPLETED') throw new Error('fixture');
  const result = await db.apply({ ...step.cmd, event: { ...step.cmd.event, screening: { ...step.cmd.event.screening, screeningId: s.screening!.screeningId } } }, 'ai');
  assert.equal(result.reason, 'EVIDENCE_ID_REUSED'); assert.deepEqual(await db.getWorkflow(s.brief.requestId), revised);
  assert.equal((await db.listEvidence(s.brief.requestId)).length, 1);
});
for (const target of ['WAITING_FOR_SCREENING', 'WAITING_FOR_CLINICAL_APPROVAL', 'WAITING_FOR_RELEASE_APPROVAL'] as const) {
  test(`no approval or release bypass from ${target}`, async () => {
    const db = store(), s = await at(db, target);
    await unchanged(db, s, command(s, { type: 'MAKE_DOWNLOAD_AVAILABLE' }), 'backend', 'WRONG_STATE');
    if (target !== 'WAITING_FOR_RELEASE_APPROVAL') await unchanged(db, s, command(s, { type: 'START_COMPILATION', compilationId: 'skip' }), 'backend');
  });
}
test('self approval and wrong clinician roles remain blocked through storage', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), step = next(s);
  await unchanged(db, s, { ...step.cmd, attemptId: 'self' }, 'poClinic', 'SELF_APPROVAL');
  await unchanged(db, s, step.cmd, 'po', 'WRONG_ROLE');
});
test('release requires separate authorized reviewer and exact tested artifact', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_RELEASE_APPROVAL'), step = next(s);
  await unchanged(db, s, { ...step.cmd, attemptId: 'same-clinician' }, 'clinicRelease', 'REVIEWER_NOT_INDEPENDENT');
  if (step.cmd.event.type !== 'RELEASE_DECISION') throw new Error('fixture');
  await unchanged(db, s, { ...step.cmd, attemptId: 'wrong-artifact', event: { ...step.cmd.event, evidence: { ...step.cmd.event.evidence, artifactHash: HASH('e') } } }, 'release', 'INVALID_RELEASE_EVIDENCE');
  await unchanged(db, s, step.cmd, 'po', 'WRONG_ROLE');
});
test('successful lifecycle stores screening, PO, clinical, artifact, verification and release evidence', async () => {
  const db = store(), s = await at(db, 'DOWNLOAD_READY'), evidence = await db.listEvidence(s.brief.requestId);
  assert.deepEqual(evidence.map(e => e.kind), ['SCREENING_COMPLETED', 'PO_DECISION', 'LOGIC_CHECKED', 'CLINICAL_DECISION', 'COMPILED', 'VERIFIED', 'RELEASE_DECISION']);
  assert.equal(s.clinicalApproval!.logicHash, s.logic!.logicHash); assert.equal(s.releaseApproval!.artifactHash, s.artifact!.artifactHash);
  assert.equal((await db.listAudit(s.brief.requestId)).length, s.version);
});
test('NOT_READY cannot advance or create evidence records', async () => {
  const db = store(), s = await at(db, 'READY_TO_ROUTE'), step = next(s); if (step.cmd.event.type !== 'APPLY_ROUTING') throw new Error('fixture');
  const history = await db.listEvidence(s.brief.requestId);
  await unchanged(db, s, { ...step.cmd, event: { ...step.cmd.event, result: { ...step.cmd.event.result, route: 'NOT_READY' } } }, 'backend', 'NOT_READY');
  assert.deepEqual(await db.listEvidence(s.brief.requestId), history);
});
test('failed verification is recorded but cannot unlock release', async () => {
  const db = store(), s = await at(db, 'VERIFYING'), step = next(s); if (step.cmd.event.type !== 'VERIFIED') throw new Error('fixture');
  const failed = await accepted(db, { ...step.cmd, event: { ...step.cmd.event, evidence: { ...step.cmd.event.evidence, passed: false } } }, 'verifier');
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.verification!.passed, false);
  await unchanged(db, failed, command(failed, { type: 'MAKE_DOWNLOAD_AVAILABLE' }), 'backend');
});

test('old events remain duplicates after request revision without restoring old snapshots', async () => {
  const db = store(), first = submit(), s = await accepted(db, first, 'po'), p = preview(2);
  const revised = await accepted(db, command(s, { type: 'REVISE_REQUEST', brief: { ...content(2), ...requestPreviewIdentity(p) } }, { snapshots: [p] }), 'po');
  const result = await db.apply({ ...first, attemptId: 'late-first-event' }, 'po');
  assert.equal(result.outcome, 'DUPLICATE'); assert.deepEqual(await db.getWorkflow(first.requestId), revised);
  assert.equal((await db.listSnapshots(first.requestId)).length, 2);
});
test('stale callbacks with a current workflow version still fail request identity checks', async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_SCREENING'), old = next(s), p = preview(2);
  const revised = await accepted(db, command(s, { type: 'REVISE_REQUEST', brief: { ...content(2), ...requestPreviewIdentity(p) } }, { snapshots: [p] }), 'po');
  await unchanged(db, revised, { ...old.cmd, event: { ...old.cmd.event, expectedVersion: revised.version } }, old.who, 'STALE_REQUEST');
});
test('LogicModel revisions preserve history but clear clinical and release approvals', async () => {
  const db = store(), s = await at(db, 'RELEASE_APPROVED'), snapshot = model(s, 2);
  const revised = await accepted(db, command(s, { type: 'REVISE_LOGIC', ...logicModelIdentity(snapshot) }, { snapshots: [snapshot] }), 'ai');
  assert.equal(revised.status, 'WAITING_FOR_LOGIC_CHECKS'); assert.equal(revised.clinicalApproval, null); assert.equal(revised.releaseApproval, null);
  assert.deepEqual(revised.confirmation, s.confirmation); assert.equal((await db.listSnapshots(s.brief.requestId)).length, 3);
  assert.equal((await db.listEvidence(s.brief.requestId)).filter(e => e.kind === 'RELEASE_DECISION').length, 1);
  await unchanged(db, revised, command(revised, { type: 'MAKE_DOWNLOAD_AVAILABLE' }), 'backend');
});
for (const decision of ['REJECT', 'RETURN'] as const) test(`clinical ${decision} persists a decision without manufacturing approval`, async () => {
  const db = store(), s = await at(db, 'WAITING_FOR_CLINICAL_APPROVAL'), step = next(s);
  const stopped = await accepted(db, { ...step.cmd, event: { ...step.cmd.event, decision, note: 'Fictional clarification needed.' } as WorkflowCommand }, 'clinic');
  assert.equal(stopped.status, decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION'); assert.equal(stopped.clinicalApproval, null);
  const record = (await db.listEvidence(s.brief.requestId)).find(e => e.kind === 'CLINICAL_DECISION')!;
  assert.equal(record.event.type, 'CLINICAL_DECISION');
  if (record.event.type === 'CLINICAL_DECISION') assert.equal(record.event.decision, decision);
  await unchanged(db, stopped, command(stopped, { type: 'START_COMPILATION', compilationId: 'skip' }), 'backend');
});
test('missing production authentication boundary cannot default to trusting caller actors', () => {
  assert.throws(() => new InMemoryOrchestratorStore({ validateSnapshot: provisionalSnapshotValidator } as InMemoryOptions), code('MISSING_BACKEND_BOUNDARY'));
});
test('record reads reject a valid snapshot substituted into the wrong storage slot', async () => {
  let substitute = false;
  const db = store({ testFaults: { readSnapshotBytes: bytes => substitute ? JSON.stringify(preview(2)) : bytes } });
  const cmd = submit(); await db.apply(cmd, 'po'); substitute = true;
  await assert.rejects(db.getReceipt(cmd.requestId, cmd.event.eventId), code('SNAPSHOT_INTEGRITY'));
  substitute = false;
  const s = (await db.getWorkflow(cmd.requestId))!, step = next(s); await db.apply(step.cmd, step.who); substitute = true;
  await assert.rejects(db.listEvidence(cmd.requestId), code('SNAPSHOT_INTEGRITY'));
});
test('two independent requests keep separate state, receipts and audit sequences', async () => {
  const db = store(), first = submit(), second = submit(1, 'fictional-002');
  await db.apply(first, 'po'); await db.apply(second, 'po');
  assert.equal((await db.getWorkflow(first.requestId))!.brief.requestId, first.requestId);
  assert.equal((await db.getWorkflow(second.requestId))!.brief.requestId, second.requestId);
  assert.equal((await db.listAudit(first.requestId))[0].sequence, 1); assert.equal((await db.listAudit(second.requestId))[0].sequence, 1);
});
test('caller mutations during actor resolution cannot change the copied transaction', async () => {
  let resume: (() => void) | undefined;
  const db = store({ resolveActor: async () => { await new Promise<void>(r => { resume = r; }); return people.po; } });
  const cmd = submit(), pending = db.apply(cmd, 'po');
  if (cmd.event.type !== 'SUBMIT') throw new Error('fixture');
  cmd.event.brief.objective = 'Unhashed alteration while resolving actor'; resume!();
  assert.equal((await pending).outcome, 'ACCEPTED'); assert.equal((await db.getWorkflow(cmd.requestId))!.brief.objective, content().objective);
});
test('failure while recording a rejection leaves existing state and audit unchanged', async () => {
  let fail = false;
  const db = store({ testFaults: { beforeCommit: () => { if (fail) throw new Error('Fictional audit unavailable'); } } });
  const s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s), audit = await db.listAudit(s.brief.requestId);
  fail = true; await assert.rejects(db.apply(step.cmd, 'po'), code('TRANSACTION_FAILED')); fail = false;
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await db.listAudit(s.brief.requestId), audit);
});

test('duplicate keys in corrupted stored bytes cannot be silently discarded on load', async () => {
  let corrupt = false;
  const db = store({ testFaults: { readSnapshotBytes: bytes => corrupt ? bytes.replace('"revision":1', '"revision":999,"revision":1') : bytes } });
  const cmd = submit(); await db.apply(cmd, 'po'); corrupt = true;
  await assert.rejects(db.getSnapshot(snapshotKey(preview())), code('SNAPSHOT_INTEGRITY'));
});
test('corrupt stored snapshots block transitions without writing new state or audit', async () => {
  let corrupt = false;
  const db = store({ testFaults: { readSnapshotBytes: bytes => corrupt ? bytes.replace('Fictional training checklist', 'Corrupted checklist') : bytes } });
  const s = await at(db, 'WAITING_FOR_SCREENING'), step = next(s), history = await db.listAudit(s.brief.requestId);
  corrupt = true; await assert.rejects(db.apply(step.cmd, step.who), code('SNAPSHOT_INTEGRITY')); corrupt = false;
  assert.deepEqual(await db.getWorkflow(s.brief.requestId), s); assert.deepEqual(await db.listAudit(s.brief.requestId), history);
  assert.equal(await db.getReceipt(s.brief.requestId, step.cmd.event.eventId), null);
});

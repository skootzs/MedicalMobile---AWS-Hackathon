import assert from 'node:assert/strict';
import test from 'node:test';
import { routeDesignBrief } from '../src/routing.ts';
import { transitionWorkflow } from '../src/workflow.ts';
import type { Actor, WorkflowEvent, WorkflowState, WorkflowStatus } from '../src/workflow.ts';
import type { DesignBrief, PreliminaryScreening } from '../src/routing.ts';

const H = (digit: string) => digit.repeat(64); // Fictional fingerprints only.
const actor = (id: string, ...roles: Actor['roles']): Actor => ({ id, roles });
const PO = actor('po', 'PO'), AI = actor('ai', 'DRAFTER'), SD = actor('sd', 'SERVICE_DESIGNER');
const CHECK = actor('check', 'CHECKER'), CLINIC = actor('clinic', 'CLINICIAN');
const COMPILER = actor('compiler', 'COMPILER'), VERIFY = actor('verify', 'VERIFIER');
const RELEASE = actor('release', 'RELEASE_APPROVER'), BACKEND = actor('backend', 'ORCHESTRATOR');
function brief(): DesignBrief {
  return { requestId: 'fictional-request', revision: 1, snapshotHash: H('a'), title: 'Training checklist',
    objective: 'Record a fictional training visit.', targetPopulation: 'Fictional households',
    requirements: [{ condition: 'Checklist completed', action: 'Show completion message' }] };
}
function identity(s: WorkflowState | null) {
  const b = s?.brief ?? brief();
  return { requestId: b.requestId, revision: b.revision, snapshotHash: b.snapshotHash };
}
function screening(s: WorkflowState): PreliminaryScreening {
  return { ...identity(s), screeningId: `screen-${s.brief.revision}`, status: 'COMPLETED', checks: {
    completeness: { outcome: 'CLEAR', reasons: [] }, ambiguities: { outcome: 'CLEAR', reasons: [] },
    contradictions: { outcome: 'CLEAR', reasons: [] }, clinicalSafety: { outcome: 'CLEAR', reasons: [] }, feasibility: { outcome: 'CLEAR', reasons: [] },
  } };
}
function event(s: WorkflowState | null, payload: Record<string, unknown>, who: Actor = BACKEND): WorkflowEvent {
  return { eventId: `event-${s?.version ?? 0}-${payload.type}`, expectedVersion: s?.version ?? 0,
    request: identity(s), actor: who, ...payload } as WorkflowEvent;
}
function accept(s: WorkflowState | null, e: WorkflowEvent): WorkflowState {
  const before = structuredClone(s), input = structuredClone(e);
  const r = transitionWorkflow(s, e);
  assert.equal(r.outcome, 'ACCEPTED', r.audit.reason);
  assert.deepEqual(s, before); assert.deepEqual(e, input);
  assert.equal(r.state!.version, (s?.version ?? 0) + 1);
  return r.state!;
}
function reject(s: WorkflowState | null, e: WorkflowEvent, reason?: string) {
  const before = structuredClone(s); const r = transitionWorkflow(s, e);
  assert.equal(r.outcome, 'REJECTED'); if (reason) assert.equal(r.audit.reason, reason);
  assert.equal(r.state, s); assert.deepEqual(s, before);
  assert.equal(r.audit.from, r.audit.to); assert.equal(r.audit.outcome, 'REJECTED');
}
function next(s: WorkflowState | null): WorkflowEvent {
  if (!s) return event(null, { type: 'SUBMIT', brief: brief() }, PO);
  switch (s.status) {
    case 'WAITING_FOR_SCREENING': return event(s, { type: 'SCREENING_COMPLETED', screening: screening(s) }, AI);
    case 'WAITING_FOR_PO_CONFIRMATION': return event(s, { type: 'PO_DECISION', confirmation: {
      ...identity(s), confirmationId: 'confirm-1', screeningId: s.screening!.screeningId, decision: 'CONFIRMED' } }, PO);
    case 'READY_TO_ROUTE': return event(s, { type: 'APPLY_ROUTING', result: routeDesignBrief({
      currentRevision: identity(s), currentScreeningId: s.screening!.screeningId, brief: s.brief, screening: s.screening, confirmation: s.confirmation }) });
    case 'READY_FOR_LOGIC_PROPOSAL': return event(s, { type: 'START_LOGIC_PROPOSAL' });
    case 'DRAFTING_LOGIC': return event(s, { type: 'LOGIC_PROPOSED', logicRevision: 1, logicHash: H('b') }, AI);
    case 'WAITING_FOR_LOGIC_CHECKS': return event(s, { type: 'LOGIC_CHECKED', ...s.logic, reportId: 'checks-1', passed: true }, CHECK);
    case 'WAITING_FOR_CLINICAL_APPROVAL': return event(s, { type: 'CLINICAL_DECISION', ...s.logic, decision: 'APPROVE' }, CLINIC);
    case 'CLINICALLY_APPROVED': return event(s, { type: 'START_COMPILATION', compilationId: 'compile-1' });
    case 'COMPILING': return event(s, { type: 'COMPILED', artifact: { ...s.logic, compilationId: s.compilationId, artifactHash: H('c') } }, COMPILER);
    case 'WAITING_FOR_VERIFICATION': return event(s, { type: 'START_VERIFICATION', verificationId: 'verify-1' });
    case 'VERIFYING': return event(s, { type: 'VERIFIED', evidence: { ...s.artifact, verificationId: s.verificationId, reportHash: H('d'), passed: true } }, VERIFY);
    case 'WAITING_FOR_RELEASE_APPROVAL': return event(s, { type: 'RELEASE_DECISION', evidence: s.verification, decision: 'APPROVE' }, RELEASE);
    case 'RELEASE_APPROVED': return event(s, { type: 'MAKE_DOWNLOAD_AVAILABLE' });
    default: throw new Error(`No default transition from ${s.status}`);
  }
}
const lifecycle: WorkflowStatus[] = ['WAITING_FOR_SCREENING', 'WAITING_FOR_PO_CONFIRMATION', 'READY_TO_ROUTE', 'READY_FOR_LOGIC_PROPOSAL',
  'DRAFTING_LOGIC', 'WAITING_FOR_LOGIC_CHECKS', 'WAITING_FOR_CLINICAL_APPROVAL', 'CLINICALLY_APPROVED', 'COMPILING',
  'WAITING_FOR_VERIFICATION', 'VERIFYING', 'WAITING_FOR_RELEASE_APPROVAL', 'RELEASE_APPROVED', 'DOWNLOAD_READY'];
function at(target: WorkflowStatus): WorkflowState {
  let s: WorkflowState | null = null;
  for (const status of lifecycle) { s = accept(s, next(s)); assert.equal(s.status, status); if (status === target) return s; }
  throw new Error(`Unknown fixture state ${target}`);
}
for (const status of lifecycle) test(`valid lifecycle reaches ${status}`, () => { assert.equal(at(status).status, status); });
for (const status of lifecycle.filter(s => s !== 'DOWNLOAD_READY')) test(`wrong role cannot advance ${status}`, () => {
  const s = at(status); reject(s, { ...next(s), actor: SD });
});
test('submission requires PO and matching initial identity', () => {
  reject(null, event(null, { type: 'SUBMIT', brief: brief() }));
  reject(null, event(null, { type: 'SUBMIT', brief: { ...brief(), revision: 2 } }, PO));
  const s = at('WAITING_FOR_SCREENING'); reject(s, event(s, { type: 'SUBMIT', brief: brief() }, PO));
});
test('pending, failed, missing-area and conflicting screening do not advance', () => {
  const s = at('WAITING_FOR_SCREENING');
  for (const changes of [{ status: 'PENDING' }, { status: 'FAILED' }, { checks: {} },
    { checks: { ...screening(s).checks, clinicalSafety: { outcome: 'CLEAR', reasons: ['Fictional concern'] } } },
    { revision: 2 }, { snapshotHash: H('e') }, { requestId: 'other' }]) {
    reject(s, event(s, { type: 'SCREENING_COMPLETED', screening: { ...screening(s), ...changes } }, AI));
  }
});
test('owning PO confirmation must match preview identity and screening', () => {
  const s = at('WAITING_FOR_PO_CONFIRMATION'), e = next(s);
  reject(s, { ...e, actor: actor('other-po', 'PO') });
  if (e.type !== 'PO_DECISION') throw new Error('fixture');
  for (const change of [{ revision: 9 }, { snapshotHash: H('e') }, { screeningId: 'old' }, { confirmationId: '' }]) reject(s, { ...e, confirmation: { ...e.confirmation, ...change } });
  const returned = accept(s, { ...e, confirmation: { ...e.confirmation, decision: 'REVISION_REQUESTED' } });
  assert.equal(returned.status, 'RETURNED_FOR_CLARIFICATION'); assert.equal(returned.clinicalApproval, null);
});
test('NOT_READY never advances state or creates SD work', () => {
  const s = at('READY_TO_ROUTE'), e = next(s); if (e.type !== 'APPLY_ROUTING') throw new Error('fixture');
  reject(s, { ...e, result: { ...e.result, route: 'NOT_READY' } }, 'NOT_READY');
});
test('eligible clinical finding routes to SD, who can clarify but cannot waive approval', () => {
  let s = at('WAITING_FOR_SCREENING'); const assessment = screening(s);
  assessment.checks.clinicalSafety = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional interpretation needs human clinical review.'] };
  s = accept(s, event(s, { type: 'SCREENING_COMPLETED', screening: assessment }, AI));
  s = accept(s, next(s)); s = accept(s, next(s)); assert.equal(s.status, 'NEEDS_SD_REVIEW');
  reject(s, event(s, { type: 'START_LOGIC_PROPOSAL' }));
  reject(s, event(s, { type: 'CLINICAL_DECISION', logicHash: H('b'), logicRevision: 1, decision: 'APPROVE' }, SD));
  const revised = accept(s, event(s, { type: 'REVISE_REQUEST', brief: { ...s.brief, revision: 2, snapshotHash: H('e') } }, SD));
  assert.equal(revised.status, 'WAITING_FOR_SCREENING'); assert.equal(revised.confirmation, null);
});
test('forged routing results cannot bypass existing Routing Box', () => {
  const s = at('READY_TO_ROUTE'), e = next(s); if (e.type !== 'APPLY_ROUTING') throw new Error('fixture');
  for (const change of [{ snapshotHash: H('e') }, { screeningId: 'other' }, { route: 'NEEDS_SD_REVIEW' }, { clinicalApprovalRequired: false }]) reject(s, { ...e, result: { ...e.result, ...change } } as WorkflowEvent, 'INVALID_ROUTING_EVIDENCE');
});
for (const status of lifecycle.filter(s => s !== 'CLINICALLY_APPROVED')) test(`compilation cannot skip gates from ${status}`, () => {
  const s = at(status); reject(s, event(s, { type: 'START_COMPILATION', compilationId: 'skip' }));
});
test('clinical self approval is blocked even with multiple claimed roles', () => {
  const s = at('WAITING_FOR_CLINICAL_APPROVAL');
  for (const who of [PO, AI, CHECK]) reject(s, { ...next(s), actor: actor(who.id, 'CLINICIAN', 'PO') }, 'SELF_APPROVAL');
});
test('clinical approval requires exact LogicModel hash and revision', () => {
  const s = at('WAITING_FOR_CLINICAL_APPROVAL');
  for (const change of [{ logicHash: H('e') }, { logicRevision: 2 }, { logicHash: undefined }]) reject(s, { ...next(s), ...change } as WorkflowEvent);
});
test('missing or stale stored clinical approval blocks compilation', () => {
  const s = at('CLINICALLY_APPROVED');
  reject({ ...s, clinicalApproval: null }, next(s), 'CLINICAL_APPROVAL_REQUIRED');
  reject({ ...s, clinicalApproval: { ...s.clinicalApproval!, logicHash: H('e') } }, next(s), 'CLINICAL_APPROVAL_REQUIRED');
});
test('failed logic checks block approval and compilation', () => {
  const s = at('WAITING_FOR_LOGIC_CHECKS'), e = next(s); if (e.type !== 'LOGIC_CHECKED') throw new Error('fixture');
  const failed = accept(s, { ...e, passed: false }); assert.equal(failed.status, 'FAILED');
  reject(failed, event(failed, { type: 'START_COMPILATION', compilationId: 'skip' }));
});
test('compiled artifact must match approved logic and active compile attempt', () => {
  const s = at('COMPILING'), e = next(s); if (e.type !== 'COMPILED') throw new Error('fixture');
  for (const change of [{ logicHash: H('e') }, { logicRevision: 2 }, { compilationId: 'old' }, { artifactHash: '' }]) reject(s, { ...e, artifact: { ...e.artifact, ...change } });
  reject(s, { ...e, actor: actor(CLINIC.id, 'COMPILER') });
});
test('verification binds actual artifact, logic, active run and valid report', () => {
  const s = at('VERIFYING'), e = next(s); if (e.type !== 'VERIFIED') throw new Error('fixture');
  for (const change of [{ artifactHash: H('e') }, { logicHash: H('e') }, { logicRevision: 2 }, { verificationId: 'old' }, { compilationId: 'old' }, { reportHash: '' }, { passed: undefined }]) reject(s, { ...e, evidence: { ...e.evidence, ...change } } as WorkflowEvent);
  for (const who of [COMPILER, CLINIC]) reject(s, { ...e, actor: actor(who.id, 'VERIFIER') });
});
test('failed verification cannot reach release or download', () => {
  const s = at('VERIFYING'), e = next(s); if (e.type !== 'VERIFIED') throw new Error('fixture');
  const failed = accept(s, { ...e, evidence: { ...e.evidence, passed: false } }); assert.equal(failed.status, 'FAILED');
  reject(failed, event(failed, { type: 'RELEASE_DECISION', evidence: failed.verification, decision: 'APPROVE' }, RELEASE));
  reject(failed, event(failed, { type: 'MAKE_DOWNLOAD_AVAILABLE' }));
});
test('release approver is separate from all contributors and clinician', () => {
  const s = at('WAITING_FOR_RELEASE_APPROVAL');
  for (const who of [PO, AI, CHECK, COMPILER, VERIFY, CLINIC]) reject(s, { ...next(s), actor: actor(who.id, 'RELEASE_APPROVER') }, 'REVIEWER_NOT_INDEPENDENT');
});
test('release approval binds exact tested artifact and report', () => {
  const s = at('WAITING_FOR_RELEASE_APPROVAL'), e = next(s); if (e.type !== 'RELEASE_DECISION') throw new Error('fixture');
  for (const change of [{ artifactHash: H('e') }, { reportHash: H('e') }, { verificationId: 'old' }, { passed: false }, { logicHash: H('e') }]) reject(s, { ...e, evidence: { ...e.evidence, ...change } });
});
test('download requires current release approval', () => {
  const s = at('WAITING_FOR_RELEASE_APPROVAL'); reject(s, event(s, { type: 'MAKE_DOWNLOAD_AVAILABLE' }));
  const approved = at('RELEASE_APPROVED'); reject({ ...approved, releaseApproval: null }, next(approved));
  reject({ ...approved, releaseApproval: { ...approved.releaseApproval!, artifactHash: H('e') } }, next(approved));
});
for (const target of ['WAITING_FOR_CLINICAL_APPROVAL', 'WAITING_FOR_RELEASE_APPROVAL'] as const) for (const decision of ['REJECT', 'RETURN'] as const) test(`${target} supports ${decision} with notes`, () => {
  const s = at(target), e = next(s); const result = accept(s, { ...e, decision, note: 'Fictional clarification requested.' } as WorkflowEvent);
  assert.equal(result.status, decision === 'REJECT' ? 'REJECTED' : 'RETURNED_FOR_CLARIFICATION');
  reject(s, { ...e, decision } as WorkflowEvent, 'INVALID_DECISION');
});
for (const status of ['WAITING_FOR_SCREENING', 'DRAFTING_LOGIC', 'WAITING_FOR_LOGIC_CHECKS', 'COMPILING', 'VERIFYING'] as const) test(`explicit failure from ${status} blocks progression`, () => {
  const s = at(status), e = event(s, { type: 'FAIL', note: 'Fictional worker failed.', ...s.logic, compilationId: s.compilationId, verificationId: s.verificationId }, next(s).actor);
  const failed = accept(s, e); assert.equal(failed.status, 'FAILED'); assert.equal(failed.stoppedAt, status);
  reject(s, { ...e, note: '' } as WorkflowEvent, 'FAILURE_NOTE_REQUIRED');
});
test('stale failure callback cannot fail newer build', () => {
  const s = at('COMPILING'); reject(s, event(s, { type: 'FAIL', ...s.logic, compilationId: 'old', note: 'Old job failed.' }, COMPILER), 'STALE_FAILURE');
});
for (const status of ['READY_TO_ROUTE', 'CLINICALLY_APPROVED', 'VERIFYING', 'DOWNLOAD_READY'] as const) test(`request edit at ${status} invalidates all later evidence`, () => {
  const s = at(status), revised = accept(s, event(s, { type: 'REVISE_REQUEST', brief: { ...s.brief, revision: 2, snapshotHash: H('e') } }, PO));
  assert.equal(revised.status, 'WAITING_FOR_SCREENING');
  for (const key of ['screening', 'confirmation', 'routing', 'logic', 'checks', 'clinicalApproval', 'artifact', 'verification', 'releaseApproval'] as const) assert.equal(revised[key], null);
  if (status !== 'DOWNLOAD_READY') reject(revised, { ...next(s), eventId: 'old-callback', expectedVersion: revised.version }, 'STALE_REQUEST');
});
for (const status of ['WAITING_FOR_CLINICAL_APPROVAL', 'CLINICALLY_APPROVED', 'COMPILING', 'WAITING_FOR_RELEASE_APPROVAL', 'DOWNLOAD_READY'] as const) test(`LogicModel edit at ${status} invalidates approvals and build evidence`, () => {
  const s = at(status), revised = accept(s, event(s, { type: 'REVISE_LOGIC', logicRevision: 2, logicHash: H('e') }, AI));
  assert.equal(revised.status, 'WAITING_FOR_LOGIC_CHECKS'); assert.deepEqual(revised.confirmation, s.confirmation);
  for (const key of ['checks', 'clinicalApproval', 'compilationId', 'artifact', 'verification', 'releaseApproval'] as const) assert.equal(revised[key], null);
  reject(revised, event(revised, { type: 'LOGIC_CHECKED', ...s.logic, reportId: 'old', passed: true }, CHECK), 'INVALID_CHECK_EVIDENCE');
});
test('invalid revision numbers, hashes and unauthorized revision actors are blocked', () => {
  const s = at('READY_TO_ROUTE');
  for (const change of [{ revision: 1 }, { revision: 3 }, { snapshotHash: s.brief.snapshotHash }, { snapshotHash: 'invented' }, { requestId: 'other' }]) reject(s, event(s, { type: 'REVISE_REQUEST', brief: { ...s.brief, revision: 2, snapshotHash: H('e'), ...change } }, PO));
  reject(s, event(s, { type: 'REVISE_REQUEST', brief: { ...s.brief, revision: 2, snapshotHash: H('e') } }, SD));
});
test('all accepted events are idempotent including late repeats', () => {
  let s: WorkflowState | null = null; const commands: WorkflowEvent[] = [];
  for (const status of lifecycle) {
    const e = next(s); commands.push(e); s = accept(s, e); const duplicate = transitionWorkflow(s, e);
    assert.equal(duplicate.outcome, 'DUPLICATE'); assert.equal(duplicate.state, s); assert.equal(s.status, status);
  }
  for (const e of commands) assert.equal(transitionWorkflow(s, e).outcome, 'DUPLICATE');
});
test('same event ID with changed content is rejected', () => {
  const e = next(null), s = accept(null, e); reject(s, { ...e, actor: AI }, 'EVENT_ID_REUSED');
});
test('optimistic version blocks stale concurrent event', () => {
  const s = at('READY_TO_ROUTE'); reject(s, { ...next(s), expectedVersion: s.version - 1 }, 'VERSION_CONFLICT');
});
test('malformed events and unknown types are rejected', () => {
  const s = at('READY_TO_ROUTE');
  for (const e of [null, {}, { ...next(s), actor: null }, { ...next(s), request: null }, { ...next(s), type: 'BYPASS_GATES' }]) reject(s, e as WorkflowEvent);
});
test('proposed audit binds actor, state change, request, logic and artifact', () => {
  const s = at('WAITING_FOR_RELEASE_APPROVAL'), r = transitionWorkflow(s, next(s));
  assert.equal(r.audit.actorId, RELEASE.id); assert.equal(r.audit.from, 'WAITING_FOR_RELEASE_APPROVAL'); assert.equal(r.audit.to, 'RELEASE_APPROVED');
  assert.deepEqual(r.audit.request, identity(s)); assert.deepEqual(r.audit.logic, s.logic); assert.equal(r.audit.artifactHash, s.artifact!.artifactHash);
});

for (const status of lifecycle.filter(s => s !== 'WAITING_FOR_RELEASE_APPROVAL')) test(`release cannot skip mandatory stages from ${status}`, () => {
  const s = at(status); reject(s, event(s, { type: 'RELEASE_DECISION', evidence: s.verification, decision: 'APPROVE' }, RELEASE));
});
test('screening validation never manufactures a stored PO confirmation', () => {
  const s = at('WAITING_FOR_PO_CONFIRMATION'); assert.equal(s.confirmation, null);
  assert.equal(s.routing, null); assert.equal(s.clinicalApproval, null);
});
test('a designer who clarified the request cannot later approve its clinical content', () => {
  let s = at('WAITING_FOR_SCREENING'); const assessment = screening(s);
  assessment.checks.ambiguities = { outcome: 'NEEDS_REVIEW', reasons: ['Fictional timing unclear.'] };
  s = accept(s, event(s, { type: 'SCREENING_COMPLETED', screening: assessment }, AI));
  s = accept(s, next(s)); s = accept(s, next(s));
  s = accept(s, event(s, { type: 'REVISE_REQUEST', brief: { ...s.brief, revision: 2, snapshotHash: H('e') } }, SD));
  while (s.status !== 'WAITING_FOR_CLINICAL_APPROVAL') s = accept(s, next(s));
  reject(s, { ...next(s), actor: actor(SD.id, 'CLINICIAN') }, 'SELF_APPROVAL');
});
test('return and rejection can be recovered only through a new applicable revision', () => {
  for (const decision of ['RETURN', 'REJECT'] as const) {
    const s = at('WAITING_FOR_CLINICAL_APPROVAL');
    const stopped = accept(s, { ...next(s), decision, note: 'Fictional rule needs correction.' } as WorkflowEvent);
    reject(stopped, event(stopped, { type: 'START_COMPILATION', compilationId: 'skip' }));
    const revised = accept(stopped, event(stopped, { type: 'REVISE_LOGIC', logicRevision: 2, logicHash: H('e') }, AI));
    assert.equal(revised.status, 'WAITING_FOR_LOGIC_CHECKS'); assert.equal(revised.clinicalApproval, null);
  }
});
test('repeated revision event stays duplicate even after current request changes', () => {
  const s = at('READY_TO_ROUTE'); const e = event(s, { type: 'REVISE_REQUEST', brief: { ...s.brief, revision: 2, snapshotHash: H('e') } }, PO);
  const revised = accept(s, e); const repeated = transitionWorkflow(revised, e);
  assert.equal(repeated.outcome, 'DUPLICATE'); assert.equal(repeated.state!.version, revised.version);
});
test('reordered JSON object keys do not create a second accepted event', () => {
  const e = next(null); const s = accept(null, e);
  const reordered = Object.fromEntries(Object.entries(e).reverse()) as WorkflowEvent;
  assert.equal(transitionWorkflow(s, reordered).outcome, 'DUPLICATE');
});
test('invalid and stale LogicModel revisions cannot remove an approval', () => {
  const s = at('CLINICALLY_APPROVED');
  for (const change of [{ logicRevision: 1, logicHash: H('e') }, { logicRevision: 3, logicHash: H('e') },
    { logicRevision: 2, logicHash: s.logic!.logicHash }, { logicRevision: 2, logicHash: '' }]) {
    reject(s, event(s, { type: 'REVISE_LOGIC', ...change }, AI), 'INVALID_LOGIC_REVISION');
  }
});

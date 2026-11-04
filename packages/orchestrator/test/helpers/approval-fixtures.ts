/** Fictional local setup copied from the storage scenarios; no tests register here. */
import assert from 'node:assert/strict';
import { createSnapshot, provisionalSnapshotValidator, requestPreviewIdentity, logicModelIdentity } from '../../src/snapshots.ts';
import type { Snapshot } from '../../src/snapshots.ts';
import { routeDesignBrief } from '../../src/routing.ts';
import type { Actor, WorkflowState, WorkflowStatus } from '../../src/workflow.ts';
import { InMemoryOrchestratorStore } from '../../src/storage/memory.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import type { ApplyCommand, WorkflowCommand } from '../../src/storage/requests.ts';

const HASH = (digit: string) => digit.repeat(64); // Fictional artifact/report fingerprints only.
const people: Record<string, Actor> = {
  po: { id: 'fictional-po', roles: ['PO'] }, ai: { id: 'fictional-ai', roles: ['DRAFTER'] },
  checker: { id: 'fictional-checker', roles: ['CHECKER'] }, clinic: { id: 'fictional-clinician', roles: ['CLINICIAN'] },
  compiler: { id: 'fictional-compiler', roles: ['COMPILER'] }, verifier: { id: 'fictional-verifier', roles: ['VERIFIER'] },
  release: { id: 'fictional-release', roles: ['RELEASE_APPROVER'] }, backend: { id: 'fictional-backend', roles: ['ORCHESTRATOR'] },
  poClinic: { id: 'fictional-po', roles: ['CLINICIAN'] }, clinicRelease: { id: 'fictional-clinician', roles: ['RELEASE_APPROVER'] },
};
export const resolveActor = (principal: unknown) => typeof principal === 'string' ? people[principal] ?? null : null;
export function store(options: Partial<InMemoryOptions> = {}) {
  return new InMemoryOrchestratorStore({ resolveActor, validateSnapshot: provisionalSnapshotValidator,
    now: () => '2026-11-03T12:00:00.000Z', ...options });
}
export function content(revision = 1) {
  return { title: `Fictional training checklist ${revision}`, objective: 'Record a training visit.', targetPopulation: 'Fictional training households',
    requirements: [{ condition: 'Checklist completed', action: 'Show completion message' }] };
}
export function preview(revision = 1, requestId = 'fictional-001') {
  return createSnapshot({ kind: 'REQUEST_PREVIEW', requestId, revision, schemaVersion: '1.0', content: content(revision) }, provisionalSnapshotValidator);
}
export function model(s: WorkflowState, revision = 1) {
  return createSnapshot({ kind: 'LOGIC_MODEL', requestId: s.brief.requestId, revision, schemaVersion: '1.0',
    requestPreview: { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash },
    content: { schemaVersion: '1.0', pathwayId: 'fictional-training', title: `Fictional model ${revision}`, language: 'en',
      sources: [{ id: 'fictional-guide', title: 'Fictional training guide' }], context: [],
      questions: [{ id: 'complete', type: 'boolean', label: 'Fictional training complete?' }], derived: [],
      decisionTables: [{ id: 'classification', hitPolicy: 'first', rows: [], otherwise: 'complete' }],
      outcomes: [{ id: 'complete', label: 'Training complete', referral: 'none' }], ambiguities: [] },
  }, provisionalSnapshotValidator);
}
export function command(s: WorkflowState | null, payload: Record<string, unknown>, options: { snapshots?: readonly Snapshot[]; suffix?: string; requestId?: string } = {}): ApplyCommand {
  const ref = s ? { requestId: s.brief.requestId, revision: s.brief.revision, snapshotHash: s.brief.snapshotHash } : requestPreviewIdentity(preview(1, options.requestId));
  const event = { eventId: `event-${s?.version ?? 0}-${payload.type}${options.suffix ?? ''}`, expectedVersion: s?.version ?? 0, request: ref, ...payload } as WorkflowCommand;
  return { requestId: ref.requestId, attemptId: `attempt-${event.eventId}${options.suffix ?? ''}`, event, ...(options.snapshots ? { snapshots: options.snapshots } : {}) };
}
export function submit(revision = 1, requestId = 'fictional-001'): ApplyCommand {
  const snapshot = preview(revision, requestId);
  return command(null, { type: 'SUBMIT', brief: { ...content(revision), ...requestPreviewIdentity(snapshot) } }, { snapshots: [snapshot], requestId });
}
async function accepted(db: InMemoryOrchestratorStore, cmd: ApplyCommand, who = 'backend') {
  const result = await db.apply(cmd, who);
  assert.equal(result.outcome, 'ACCEPTED', result.reason);
  return (await db.getWorkflow(cmd.requestId))!;
}
export function next(s: WorkflowState): { cmd: ApplyCommand; who: string } {
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
export async function at(db: InMemoryOrchestratorStore, target: WorkflowStatus): Promise<WorkflowState> {
  let s = await accepted(db, submit(), 'po');
  while (s.status !== target) { const { cmd, who } = next(s); s = await accepted(db, cmd, who); }
  return s;
}

/** TEST ONLY: opaque object-identity sessions and fictional R4 metadata; not real auth/checking. */
import type { Actor } from '../../src/workflow.ts';
import { DraftingCallbackService } from '../../src/callbacks.ts';
import type { DraftingCallbackDependencies, DraftingResultCommand } from '../../src/callbacks.ts';
import type { DraftingResultStore } from '../../src/storage/drafting-results.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { provisionalSnapshotValidator } from '../../src/snapshots.ts';
import type { LogicModelSnapshot } from '../../src/snapshots.ts';
import type { LogicValidationBoundary, ProposalValidationResult } from '../../src/callback-contracts.ts';
import { jobFixture, recordedJob, wrapJobStore } from './job-fixtures.ts';
import { resolveReviewActor } from './review-fixtures.ts';
import { model } from './approval-fixtures.ts';

export class FictionalLogicValidation implements LogicValidationBoundary {
  calls = 0;
  validateSnapshot = provisionalSnapshotValidator;
  async validateProposal(snapshot: LogicModelSnapshot): Promise<ProposalValidationResult> {
    this.calls++;
    return { status: 'PASSED', validatorId: 'fictional-r4-validator', validatorVersion: 'fixture-v1', resultId: `fictional-validation-${snapshot.snapshotHash.slice(0, 16)}`,
      reportId: `fictional-report-${snapshot.snapshotHash.slice(0, 16)}`, requestId: snapshot.requestId, requestPreview: { ...snapshot.requestPreview },
      logic: { logicRevision: snapshot.revision, logicHash: snapshot.snapshotHash }, schemaVersion: snapshot.schemaVersion, hashPolicyVersion: snapshot.hashPolicyVersion };
  }
}
export function callbackFixture(options: Partial<InMemoryOptions> = {}, changes: Partial<DraftingCallbackDependencies> = {}) {
  // Identity is established by this test provider's Map membership, never by object fields.
  const workerPrincipal = Object.freeze({ session: 'fictional-service-session' });
  const wrongRolePrincipal = Object.freeze({ session: 'fictional-nonworker-session' });
  const otherWorkerPrincipal = Object.freeze({ session: 'fictional-other-worker-session' });
  const verified = new Map<unknown, Actor>([[workerPrincipal, { id: 'fictional-r3-worker', roles: ['DRAFTER'] }],
    [wrongRolePrincipal, { id: 'fictional-nonworker', roles: ['PO'] }], [otherWorkerPrincipal, { id: 'fictional-other-worker', roles: ['DRAFTER'] }]]);
  const resolveWorker = (principal: unknown) => verified.get(principal) ?? null;
  const f = jobFixture({ ...options, resolveActor: options.resolveActor ?? (p => resolveWorker(p) ?? resolveReviewActor(p)) });
  const validation = new FictionalLogicValidation();
  const deps: DraftingCallbackDependencies = { store: f.db, resolveActor: resolveWorker,
    canAccessRequest: (p, id) => verified.has(p) && id === 'fictional-001', validation, ...changes };
  return { ...f, deps, validation, workerPrincipal, wrongRolePrincipal, otherWorkerPrincipal, callbacks: new DraftingCallbackService(deps) };
}
export async function draftingCallback(f = callbackFixture()) {
  const recorded = await recordedJob(f), s = (await f.db.getWorkflow('fictional-001'))!;
  const c: DraftingResultCommand = { requestId: recorded.job.requestId, jobId: recorded.job.jobId, eventId: 'fictional-drafting-result', expectedVersion: recorded.job.workflowVersion,
    sourceWorkflowVersion: recorded.job.sourceWorkflowVersion, revision: recorded.job.requestPreview.revision, snapshotHash: recorded.job.requestPreview.snapshotHash,
    schemaVersion: '1.0', logicModel: model(s).content };
  return { ...f, s, c, job: recorded.job };
}
export function wrapResultStore(db: DraftingResultStore, changes: Partial<DraftingResultStore>): DraftingResultStore {
  return { ...wrapJobStore(db, {}), getDraftingResult: (requestId, jobId) => db.getDraftingResult(requestId, jobId), ...changes };
}

/** TEST ONLY: fictional identities and local fake adapters. */
import assert from 'node:assert/strict';
import { DraftingHandoffService } from '../../src/jobs.ts';
import type { DraftingHandoffCommand, DraftingHandoffDependencies } from '../../src/jobs.ts';
import type { JobStore } from '../../src/storage/jobs.ts';
import type { InMemoryOptions } from '../../src/storage/memory.ts';
import { routingFixture, routingCommand } from './routing-service-fixtures.ts';
import { at } from './approval-fixtures.ts';
import { wrapStore } from './api-fixtures.ts';
import { MockDraftingWorker } from './mock-drafting-worker.ts';
export function jobFixture(options: Partial<InMemoryOptions> = {}, changes: Partial<DraftingHandoffDependencies> = {}) {
  const f = routingFixture(options), worker = new MockDraftingWorker();
  const deps: DraftingHandoffDependencies = { ...f.deps, store: f.db, worker, ...changes };
  return { ...f, deps, worker, jobs: new DraftingHandoffService(deps) };
}
export async function readyJob(f = jobFixture()) {
  const before = await at(f.db, 'READY_TO_ROUTE'); const routing = await f.routing.execute(routingCommand(before), 'backend'); assert.equal(routing.status, 'SUCCESS');
  const s = (await f.db.getWorkflow('fictional-001'))!;
  const c: DraftingHandoffCommand = { ...routingCommand(s, 'fictional-start-drafting'), routingEventId: 'fictional-route' };
  return { ...f, s, c };
}
export async function recordedJob(f = jobFixture()) {
  const r = await readyJob(f), result = await r.jobs.start(r.c, 'backend'); assert.equal(result.status, 'INTENT_RECORDED', result.reason);
  return { ...r, job: result.job!, delivery: { requestId: r.c.requestId, jobId: result.job!.jobId, expectedVersion: result.job!.workflowVersion } };
}
export function wrapJobStore(db: JobStore, changes: Partial<JobStore>): JobStore {
  return { ...wrapStore(db, {}), getJob: (id, jobId) => db.getJob(id, jobId), listJobs: id => db.listJobs(id), recordJobDelivery: (attempt, principal) => db.recordJobDelivery(attempt, principal), ...changes };
}

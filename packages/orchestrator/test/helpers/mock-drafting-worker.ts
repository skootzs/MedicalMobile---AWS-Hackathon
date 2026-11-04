/** TEST ONLY: records fictional delivery IDs; never generates or executes clinical logic. */
import type { DraftingWorker, DraftingJobIntent, WorkerOutcome, WorkerResult } from '../../src/job-intents.ts';
import { canonicalizeJson } from '../../src/snapshots.ts';
export class MockDraftingWorker implements DraftingWorker {
  #accepted = new Map<string, string>();
  #attempts: DraftingJobIntent[] = [];
  #script: (WorkerOutcome | 'THROW')[];
  constructor(script: readonly (WorkerOutcome | 'THROW')[] = []) { this.#script = [...script]; }
  get logicalJobs() { return this.#accepted.size; }
  get attempts(): readonly DraftingJobIntent[] { return structuredClone(this.#attempts); }
  async deliver(intent: DraftingJobIntent): Promise<WorkerResult> {
    const job = structuredClone(intent); this.#attempts.push(job);
    const old = this.#accepted.get(job.jobId), bytes = canonicalizeJson(job);
    if (old) return { outcome: old === bytes ? 'DUPLICATE' : 'FAILED', jobId: job.jobId, idempotencyKey: job.idempotencyKey };
    const outcome = this.#script.shift() ?? 'ACCEPTED';
    if (outcome === 'THROW') throw Error('Fictional unavailable worker; private details must not leak.');
    if (outcome === 'ACCEPTED' || outcome === 'DUPLICATE') this.#accepted.set(job.jobId, bytes);
    return { outcome, jobId: job.jobId, idempotencyKey: job.idempotencyKey };
  }
}

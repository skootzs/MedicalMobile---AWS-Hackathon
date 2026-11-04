import type { DraftingJobIntent, WorkerOutcome } from '../job-intents.ts';
import type { ApplyResult, OrchestratorStore } from './requests.ts';

/** Internal transport-attempt metadata. No worker execution or result callback authority. */
export interface JobDeliveryAttempt {
  requestId: string;
  jobId: string;
  expectedVersion: number;
  attemptId: string;
  outcome: WorkerOutcome | 'NOT_ATTEMPTED';
  expectedActorId?: string;
  /** Internal rejection only; can never grant permission. */
  preconditionFailure?: string;
}
export interface JobStore extends OrchestratorStore {
  getJob(requestId: string, jobId: string): Promise<DraftingJobIntent | null>;
  listJobs(requestId: string): Promise<readonly DraftingJobIntent[]>;
  /** Append a transport audit only, with actor/current-job checks and no state advancement. */
  recordJobDelivery(attempt: JobDeliveryAttempt, principal: unknown): Promise<ApplyResult>;
}

import type { VerifyBuildJobIntent, VerifyBuildOutbox } from '../verify-build-contracts.ts';
import type { OrchestratorStore } from './requests.ts';
/** Same apply() transaction as compilation; no independent putJob/putOutbox. */
export interface VerifyBuildStore extends OrchestratorStore {
  getVerifyBuildJob(requestId: string, jobId: string): Promise<VerifyBuildJobIntent | null>;
  listVerifyBuildJobs(requestId: string): Promise<readonly VerifyBuildJobIntent[]>;
  getVerifyBuildOutbox(requestId: string, jobId: string): Promise<VerifyBuildOutbox | null>;
}

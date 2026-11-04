import type { CompilationJobIntent, CompilationOutbox } from '../compilation-contracts.ts';
import type { OrchestratorStore } from './requests.ts';
/** Same apply() transaction; no independent putJob/putOutbox or delivery framework. */
export interface CompilationStore extends OrchestratorStore {
  getCompilationJob(requestId: string, jobId: string): Promise<CompilationJobIntent | null>;
  listCompilationJobs(requestId: string): Promise<readonly CompilationJobIntent[]>;
  getCompilationOutbox(requestId: string, jobId: string): Promise<CompilationOutbox | null>;
}

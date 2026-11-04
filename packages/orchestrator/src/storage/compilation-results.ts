import type { CompilationResultRecord } from '../compilation-result-contracts.ts';
import type { CompilationStore } from './compilations.ts';
export interface CompilationResultStore extends CompilationStore {
  getCompilationResult(requestId: string, jobId: string): Promise<CompilationResultRecord | null>;
}

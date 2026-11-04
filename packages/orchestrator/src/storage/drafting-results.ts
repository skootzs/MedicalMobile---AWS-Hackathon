import type { DraftingResultRecord } from '../callback-contracts.ts';
import type { JobStore } from './jobs.ts';
/** Internal read port. Result acceptance is written only through store.apply(). */
export interface DraftingResultStore extends JobStore {
  getDraftingResult(requestId: string, jobId: string): Promise<DraftingResultRecord | null>;
}

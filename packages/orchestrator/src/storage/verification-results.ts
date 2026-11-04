import type { VerificationResultRecord } from '../verification-result-contracts.ts';
import type { VerifyBuildStore } from './verify-build.ts';
export interface VerificationResultStore extends VerifyBuildStore {
  getVerificationResult(requestId: string, jobId: string): Promise<VerificationResultRecord | null>;
}

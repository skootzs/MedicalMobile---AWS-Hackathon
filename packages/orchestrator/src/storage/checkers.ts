import type { AcceptedCheckerResult, CheckerInvocation } from '../checker-contracts.ts';
import type { OrchestratorStore, ApplyResult } from './requests.ts';
export interface AuthorizeCheckerInput { requestId: string; attemptId: string; invocation: CheckerInvocation; expectedActorId?: string }
/** Internal invocation metadata only, with no worker dispatch or new workflow state. */
export interface CheckerStore extends OrchestratorStore {
  authorizeChecker(input: AuthorizeCheckerInput, principal: unknown): Promise<ApplyResult>;
  getCheckerInvocation(requestId: string, invocationId: string): Promise<CheckerInvocation | null>;
  getCheckerReport(requestId: string, reportId: string): Promise<AcceptedCheckerResult | null>;
}

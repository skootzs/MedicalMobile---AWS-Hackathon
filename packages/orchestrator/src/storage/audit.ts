import type { AcceptedCheckerResult, CheckerInvocation, CheckerReport } from '../checker-contracts.ts';
import type { DraftingResultRecord, LogicValidationReference } from '../callback-contracts.ts';
import type { DraftingJobIntent, WorkerOutcome } from '../job-intents.ts';
import type { ProposedAuditEvent } from '../workflow.ts';
import type { RevisionIdentity, RoutingResult } from '../routing.ts';

/** Append-only proposed workflow audit plus backend recording metadata. */
export interface AuditRecord extends ProposedAuditEvent {
  auditId: string;
  sequence: number;
  recordedAt: string;
  checkerInvocation?: CheckerInvocation;
  checkerResult?: AcceptedCheckerResult;
  checkerAttempt?: CheckerReport;
  jobIntent?: DraftingJobIntent;
  callbackValidation?: LogicValidationReference;
  draftingResult?: DraftingResultRecord;
  jobDelivery?: { jobId: string; outcome: WorkerOutcome | 'NOT_ATTEMPTED' };
  /** Accepted APPLY_ROUTING only: exact decision and evidence references. */
  routing?: RoutingResult;
}
export interface EventReceipt {
  request: RevisionIdentity;
  eventId: string;
  /** Existing workflow event fingerprint, not a content snapshot hash. */
  fingerprint: string;
  workflowVersion: number;
  auditId: string;
  /** Optional for commands predating the application-service boundary. */
  commandFingerprint?: string;
  checkerInvocation?: CheckerInvocation;
  checkerResult?: AcceptedCheckerResult;
  /** START_LOGIC_PROPOSAL intent committed with this receipt. */
  jobId?: string;
  /** Original accepted callback outcome, independent of later workflow revisions. */
  draftingResult?: DraftingResultRecord;
  /** Immutable accepted routing decision; absent on older/non-routing receipts. */
  routing?: RoutingResult;
}
